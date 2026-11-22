import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { WorkloadStack } from './workload-stack';
import { ObservabilityStack } from './observability-stack';

export interface ResponseStackProps extends cdk.StackProps {
  workload: WorkloadStack;
  telemetry: ObservabilityStack;
}

const ALARM = {
  cpu: 'obs-ecs-cpu-high',
  http5xx: 'obs-alb-5xx-rate',
  errors: 'obs-app-error-count',
};

/**
 * ObsResponse: alarms, notification and automated remediation, plus the operations dashboard.
 * Alarm -> SNS (email) and Alarm -> EventBridge -> Lambda remediator.
 */
export class ResponseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ResponseStackProps) {
    super(scope, id, props);
    const { alb, appService, cluster, db, webAsg } = props.workload;
    const minute = cdk.Duration.minutes(1);

    // ---------- On-call notification ----------
    const alertEmail: string = this.node.tryGetContext('alertEmail') ?? 'emmanuel.mulala@student.moringaschool.com';
    const topic = new sns.Topic(this, 'OnCall', { topicName: 'obs-oncall', displayName: 'Observability on-call' });
    topic.addSubscription(new subs.EmailSubscription(alertEmail));

    // ---------- Alarms ----------
    // 1. ECS CPU > 80%: Maximum across tasks, so a single overloaded task is caught
    const cpuAlarm = new cloudwatch.Alarm(this, 'EcsCpuHigh', {
      alarmName: ALARM.cpu,
      alarmDescription: 'ECS API task CPU above 80% for 2 minutes. Auto-remediation: restart tasks.',
      metric: appService.metricCpuUtilization({ statistic: 'Maximum', period: minute }),
      threshold: 80,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // 2. ALB 5xx rate > 5% of requests (target + load balancer errors)
    const errorRate = new cloudwatch.MathExpression({
      label: '5xx rate (%)',
      expression: 'IF(req > 0, 100 * (FILL(t5, 0) + FILL(e5, 0)) / req, 0)',
      period: minute,
      usingMetrics: {
        req: alb.metrics.requestCount({ statistic: 'Sum', period: minute }),
        t5: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { statistic: 'Sum', period: minute }),
        e5: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { statistic: 'Sum', period: minute }),
      },
    });
    const http5xxAlarm = new cloudwatch.Alarm(this, 'Alb5xxRate', {
      alarmName: ALARM.http5xx,
      alarmDescription: 'More than 5% of ALB requests returned 5xx for 2 minutes. Action: page on-call.',
      metric: errorRate,
      threshold: 5,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // 3. ErrorCount > 10 in 5 minutes (from the log metric filter)
    const errorAlarm = new cloudwatch.Alarm(this, 'AppErrorCount', {
      alarmName: ALARM.errors,
      alarmDescription: 'More than 10 application ERROR log lines in 5 minutes. Auto-remediation: tag web instances for investigation.',
      metric: props.telemetry.errorCount,
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    for (const alarm of [cpuAlarm, http5xxAlarm, errorAlarm]) {
      alarm.addAlarmAction(new cwActions.SnsAction(topic));
      alarm.addOkAction(new cwActions.SnsAction(topic));
    }

    // ---------- Automated remediation: EventBridge -> Lambda ----------
    const remediator = new lambda.Function(this, 'Remediator', {
      functionName: 'obs-remediator',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'remediator.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambda')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        CLUSTER: cluster.clusterName,
        SERVICE: appService.serviceName,
        TOPIC_ARN: topic.topicArn,
        CPU_ALARM: ALARM.cpu,
        HTTP5XX_ALARM: ALARM.http5xx,
        ERROR_ALARM: ALARM.errors,
        WEB_TAG_KEY: 'Tier',
        WEB_TAG_VALUE: 'web',
      },
      logGroup: new logs.LogGroup(this, 'RemediatorLogs', {
        logGroupName: '/aws/lambda/obs-remediator',
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Least privilege: restart only this service, tag only web-tier instances, publish only to this topic
    remediator.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
      resources: [appService.serviceArn],
    }));
    remediator.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));
    remediator.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
      conditions: { StringEquals: { 'aws:ResourceTag/Tier': 'web' } },
    }));
    topic.grantPublish(remediator);

    new events.Rule(this, 'AlarmToRemediator', {
      ruleName: 'obs-alarm-remediation',
      description: 'Route obs-* alarms entering ALARM to the remediation Lambda',
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        detail: { alarmName: events.Match.prefix('obs-'), state: { value: ['ALARM'] } },
      },
      targets: [new targets.LambdaFunction(remediator, { retryAttempts: 2 })],
    });

    // ---------- Operations dashboard ----------
    const albM = alb.metrics;
    const agent = (metricName: string, label: string) => new cloudwatch.Metric({
      namespace: 'CWAgent', metricName, label, period: minute, statistic: 'Average',
      dimensionsMap: { AutoScalingGroupName: webAsg.autoScalingGroupName },
    });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'obs-platform',
      defaultInterval: cdk.Duration.hours(1),
    });
    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({ title: 'Alarm status', alarms: [cpuAlarm, http5xxAlarm, errorAlarm], width: 24, height: 3 }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ALB requests and 5xx', width: 8,
        left: [albM.requestCount({ statistic: 'Sum', period: minute, label: 'Requests' })],
        right: [
          albM.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { statistic: 'Sum', period: minute, label: 'Target 5xx' }),
          albM.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { statistic: 'Sum', period: minute, label: 'ALB 5xx' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB 5xx rate (%) vs alarm', width: 8,
        left: [errorRate],
        leftAnnotations: [{ value: 5, label: '5% alarm', color: '#d62728' }],
      }),
      new cloudwatch.GraphWidget({
        title: 'Response time (p95, s)', width: 8,
        left: [albM.targetResponseTime({ statistic: 'p95', period: minute, label: 'Target p95' })],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ECS API CPU / memory (%)', width: 8,
        left: [
          appService.metricCpuUtilization({ statistic: 'Maximum', period: minute, label: 'CPU max' }),
          appService.metricMemoryUtilization({ statistic: 'Average', period: minute, label: 'Memory avg' }),
        ],
        leftAnnotations: [{ value: 80, label: '80% alarm', color: '#d62728' }],
      }),
      new cloudwatch.GraphWidget({
        title: 'Application ErrorCount (log metric filter)', width: 8,
        left: [props.telemetry.errorCount.with({ label: 'ERROR lines / 5 min' })],
        leftAnnotations: [{ value: 10, label: 'alarm > 10', color: '#d62728' }],
      }),
      new cloudwatch.GraphWidget({
        title: 'EC2 web tier (CloudWatch Agent)', width: 8,
        left: [agent('mem_used_percent', 'Memory used %'), agent('disk_used_percent', 'Disk used %')],
        right: [new cloudwatch.Metric({
          namespace: 'AWS/EC2', metricName: 'CPUUtilization', label: 'CPU %', period: minute, statistic: 'Average',
          dimensionsMap: { AutoScalingGroupName: webAsg.autoScalingGroupName },
        })],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'RDS connections / CPU', width: 12,
        left: [db.metricDatabaseConnections({ period: minute, label: 'Connections' })],
        right: [db.metricCPUUtilization({ period: minute, label: 'CPU %' })],
      }),
      new cloudwatch.GraphWidget({
        title: 'RDS read / write latency (s)', width: 12,
        left: [
          db.metric('ReadLatency', { period: minute, statistic: 'Average', label: 'Read latency' }),
          db.metric('WriteLatency', { period: minute, statistic: 'Average', label: 'Write latency' }),
        ],
      }),
    );

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/obs-platform`,
    });
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'RemediatorFunction', { value: remediator.functionName });
  }
}
