#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WorkloadStack } from '../lib/workload-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { ResponseStack } from '../lib/response-stack';

const app = new cdk.App();
const env = { account: '586481704498', region: 'eu-west-1' };

const workload = new WorkloadStack(app, 'ObsWorkload', {
  env,
  description: 'Observability platform: VPC, ALB, EC2 web tier (CloudWatch Agent), ECS API (X-Ray), RDS MySQL',
});
const telemetry = new ObservabilityStack(app, 'ObsTelemetry', {
  env, workload,
  description: 'Observability platform: log groups to Firehose to S3, ErrorCount metric filter, Logs Insights queries',
});
new ResponseStack(app, 'ObsResponse', {
  env, workload, telemetry,
  description: 'Observability platform: alarms, SNS on-call, EventBridge + Lambda remediation, dashboard',
});

cdk.Tags.of(app).add('Project', 'observability-platform');
