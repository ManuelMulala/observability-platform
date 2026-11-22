import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { WorkloadStack } from './workload-stack';

export interface ObservabilityStackProps extends cdk.StackProps {
  workload: WorkloadStack;
}

/**
 * ObsTelemetry: centralised log pipeline and log-based signals.
 * All five log groups -> subscription filters -> Kinesis Data Firehose -> S3 (long-term, partitioned by date).
 * Plus the ErrorCount metric filter and saved CloudWatch Logs Insights queries.
 */
export class ObservabilityStack extends cdk.Stack {
  public readonly errorCount: cloudwatch.Metric;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { logGroups } = props.workload;

    // ---------- Long-term log archive ----------
    const archive = new s3.Bucket(this, 'LogArchive', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{
        transitions: [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: cdk.Duration.days(30) }],
        expiration: cdk.Duration.days(365),
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY, // lab only
      autoDeleteObjects: true,
    });

    // CloudWatch Logs already gzip-compresses subscription data, so Firehose stores it as-is with a .gz extension
    const stream = new firehose.DeliveryStream(this, 'LogStream', {
      deliveryStreamName: 'obs-logs-to-s3',
      destination: new firehose.S3Bucket(archive, {
        dataOutputPrefix: 'logs/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/',
        errorOutputPrefix: 'errors/!{firehose:error-output-type}/!{timestamp:yyyy}/!{timestamp:MM}/!{timestamp:dd}/',
        bufferingInterval: cdk.Duration.seconds(60),
        bufferingSize: cdk.Size.mebibytes(5),
        fileExtension: '.gz',
      }),
    });

    const sources: Array<[string, logs.ILogGroup]> = [
      ['WebAccess', logGroups.webAccess],
      ['WebError', logGroups.webError],
      ['App', logGroups.app],
      ['DbError', logGroups.dbError],
      ['DbSlowQuery', logGroups.dbSlow],
    ];
    for (const [name, group] of sources) {
      new logs.SubscriptionFilter(this, `${name}ToFirehose`, {
        logGroup: group,
        destination: new destinations.FirehoseDestination(stream),
        filterPattern: logs.FilterPattern.allEvents(),
      });
    }

    // ---------- Log-based metric: application ERROR lines ----------
    const errorFilter = new logs.MetricFilter(this, 'AppErrorCount', {
      logGroup: logGroups.app,
      filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'ERROR'),
      metricNamespace: 'ObsPlatform',
      metricName: 'ErrorCount',
      metricValue: '1',
      defaultValue: 0,
    });
    this.errorCount = errorFilter.metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) });

    // ---------- Saved Logs Insights queries ----------
    new logs.QueryDefinition(this, 'ErrorSpikesQuery', {
      queryDefinitionName: 'obs/01-error-and-5xx-spikes',
      logGroups: [logGroups.app],
      queryString: new logs.QueryString({
        fields: ['@timestamp', 'level', 'status', 'path', 'msg'],
        filterStatements: ['level = "ERROR" or status >= 500'],
        statsStatements: ['count(*) as errors by bin(1m) as minute, path'],
        sort: 'minute desc',
      }),
    });

    new logs.QueryDefinition(this, 'SlowRequestsQuery', {
      queryDefinitionName: 'obs/02-slow-requests-with-trace-ids',
      logGroups: [logGroups.app],
      queryString: new logs.QueryString({
        fields: ['@timestamp', 'path', 'status', 'latencyMs', 'traceId'],
        filterStatements: ['msg = "request" and latencyMs > 1000'],
        sort: 'latencyMs desc',
        limit: 20,
      }),
    });

    new logs.QueryDefinition(this, 'DbSlowQueriesQuery', {
      queryDefinitionName: 'obs/03-rds-slow-queries',
      logGroups: [logGroups.dbSlow],
      queryString: new logs.QueryString({
        fields: ['@timestamp', '@message'],
        filterStatements: ['@message like /Query_time/'],
        sort: '@timestamp desc',
        limit: 20,
      }),
    });

    new cdk.CfnOutput(this, 'LogArchiveBucket', { value: archive.bucketName });
    new cdk.CfnOutput(this, 'FirehoseStream', { value: stream.deliveryStreamName });
  }
}
