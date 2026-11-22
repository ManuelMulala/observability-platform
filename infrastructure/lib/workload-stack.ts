import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';

const REPO_ROOT = path.join(__dirname, '..', '..');
const DB_INSTANCE_ID = 'obs-db';

/**
 * ObsWorkload: the monitored application.
 * ALB -> EC2 web tier (Apache + CloudWatch Agent) and ECS Fargate API (+ X-Ray daemon) -> RDS MySQL.
 * Every log group is created here first, with retention, so the observability stack can subscribe to it.
 */
export class WorkloadStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly webAsg: autoscaling.AutoScalingGroup;
  public readonly cluster: ecs.Cluster;
  public readonly appService: ecs.FargateService;
  public readonly db: rds.DatabaseInstance;
  public readonly logGroups: Record<'webAccess' | 'webError' | 'app' | 'dbError' | 'dbSlow', logs.LogGroup>;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------- Network: 2 AZs, no NAT gateway (public subnets + locked-down SGs, isolated DB subnets) ----------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: [`${this.region}a`, `${this.region}b`],
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, description: 'ALB - HTTP from the internet' });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
    const webSg = new ec2.SecurityGroup(this, 'WebSg', { vpc, description: 'EC2 web tier - HTTP from ALB only' });
    webSg.addIngressRule(albSg, ec2.Port.tcp(80), 'HTTP from ALB');
    const appSg = new ec2.SecurityGroup(this, 'AppSg', { vpc, description: 'ECS API - app port from ALB only' });
    appSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'App port from ALB');
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'RDS - MySQL from ECS only', allowAllOutbound: false });
    dbSg.addIngressRule(appSg, ec2.Port.tcp(3306), 'MySQL from ECS tasks');

    // ---------- Log groups (7-day retention; long-term copies go to S3 via Firehose) ----------
    const lg = (cid: string, name: string) => new logs.LogGroup(this, cid, {
      logGroupName: name,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.logGroups = {
      webAccess: lg('WebAccessLogs', '/obs/web/access'),
      webError: lg('WebErrorLogs', '/obs/web/error'),
      app: lg('AppLogs', '/obs/app'),
      // RDS writes exported logs to these fixed names; creating them first lets us set retention and subscribe
      dbError: lg('DbErrorLogs', `/aws/rds/instance/${DB_INSTANCE_ID}/error`),
      dbSlow: lg('DbSlowQueryLogs', `/aws/rds/instance/${DB_INSTANCE_ID}/slowquery`),
    };
    const xrayLogs = lg('XrayDaemonLogs', '/obs/xray-daemon');

    // ---------- Load balancer: / -> EC2 web tier, /api/* -> ECS API ----------
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc, internetFacing: true, securityGroup: albSg, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    const listener = this.alb.addListener('Http', { port: 80, open: false });

    // ---------- EC2 web tier with the CloudWatch Agent ----------
    // Agent config from the repo; retention is managed by CDK above, so it is removed from the agent config
    const agentConfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'web', 'cloudwatch-agent.json'), 'utf8'));
    for (const f of agentConfig.logs.logs_collected.files.collect_list) delete f.retention_in_days;
    const userDataScript = fs.readFileSync(path.join(REPO_ROOT, 'web', 'userdata.sh'), 'utf8')
      // Replace only the placeholder on its own line (the header comment also mentions it)
      .replace(/^__AGENT_CONFIG__$/m, JSON.stringify(agentConfig, null, 2));
    if (userDataScript.includes('\n__AGENT_CONFIG__\n')) throw new Error('Agent config placeholder was not replaced');

    const webRole = new iam.Role(this, 'WebRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const webTemplate = new ec2.LaunchTemplate(this, 'WebTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData: ec2.UserData.custom(userDataScript),
      role: webRole,
      securityGroup: webSg,
      associatePublicIpAddress: true, // no NAT: public IP to reach dnf repos and CloudWatch
      requireImdsv2: true,
    });

    this.webAsg = new autoscaling.AutoScalingGroup(this, 'WebAsg', {
      vpc,
      autoScalingGroupName: 'obs-web',
      launchTemplate: webTemplate,
      minCapacity: 1,
      maxCapacity: 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    cdk.Tags.of(this.webAsg).add('Tier', 'web'); // propagated to instances; used by the remediation Lambda
    // The agent would auto-create its log groups if it started first, which would break the CDK-managed ones
    this.webAsg.node.addDependency(this.logGroups.webAccess, this.logGroups.webError);

    listener.addTargets('Web', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.webAsg],
      healthCheck: { path: '/health', interval: cdk.Duration.seconds(15), healthyThresholdCount: 2 },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ---------- RDS MySQL with slow query log, Enhanced Monitoring and Database Insights ----------
    const engine = rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.of('8.4.7', '8.4') });
    this.db = new rds.DatabaseInstance(this, 'Database', {
      engine,
      instanceIdentifier: DB_INSTANCE_ID,
      // Database Insights / Performance Insights is not supported on micro or small MySQL instances
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MEDIUM),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      credentials: rds.Credentials.fromGeneratedSecret('obsadmin'),
      databaseName: 'obs',
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      parameterGroup: new rds.ParameterGroup(this, 'DbParams', {
        engine,
        description: 'Slow query logging for observability',
        parameters: {
          slow_query_log: '1', long_query_time: '1', log_output: 'FILE',
          // Database Insights cannot manage the Performance Schema on t4g.medium, so turn it on explicitly
          // (static parameter: needs a DB reboot after the first deploy)
          performance_schema: '1',
        },
      }),
      cloudwatchLogsExports: ['error', 'slowquery'],
      monitoringInterval: cdk.Duration.seconds(60), // Enhanced Monitoring (OS metrics)
      enablePerformanceInsights: true,
      databaseInsightsMode: rds.DatabaseInsightsMode.STANDARD, // free 7-day tier
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      backupRetention: cdk.Duration.days(0), // lab only: no leftover automated snapshots
      deleteAutomatedBackups: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.db.node.addDependency(this.logGroups.dbError, this.logGroups.dbSlow);

    // ---------- ECS Fargate API with X-Ray daemon sidecar ----------
    this.cluster = new ecs.Cluster(this, 'Cluster', { clusterName: 'obs-platform', vpc });

    const task = new ecs.FargateTaskDefinition(this, 'AppTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    task.taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'));

    const dbSecret = this.db.secret!;
    task.addContainer('app', {
      containerName: 'app',
      // Built from ../app and pushed to the CDK assets repository during cdk deploy
      image: ecs.ContainerImage.fromAsset(path.join(REPO_ROOT, 'app'), { platform: Platform.LINUX_AMD64 }),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        DB_HOST: this.db.dbInstanceEndpointAddress,
        DB_NAME: 'obs',
        AWS_XRAY_DAEMON_ADDRESS: '127.0.0.1:2000',
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'app', logGroup: this.logGroups.app }),
    });
    task.addContainer('xray', {
      containerName: 'xray-daemon',
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
      cpu: 32,
      memoryReservationMiB: 64,
      essential: false, // the API keeps serving even if tracing is unavailable
      portMappings: [{ containerPort: 2000, protocol: ecs.Protocol.UDP }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'xray', logGroup: xrayLogs }),
    });

    this.appService = new ecs.FargateService(this, 'AppService', {
      cluster: this.cluster,
      serviceName: 'obs-app',
      taskDefinition: task,
      desiredCount: 2,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [appSg],
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    listener.addTargets('App', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api', '/api/*'])],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.appService],
      healthCheck: { path: '/api/health', interval: cdk.Duration.seconds(15), healthyThresholdCount: 2 },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    new cdk.CfnOutput(this, 'AlbUrl', { value: `http://${this.alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'DbIdentifier', { value: DB_INSTANCE_ID });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: this.appService.serviceName });
    new cdk.CfnOutput(this, 'WebAsgName', { value: this.webAsg.autoScalingGroupName });
  }
}
