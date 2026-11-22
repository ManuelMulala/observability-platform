# Observability-as-a-Service (Capstone 7)

A small three-tier workload on AWS with full observability: metrics, logs, traces, alarms and automated incident response. Everything is defined in AWS CDK (TypeScript) and deployed to **eu-west-1**.

The project report is in [REPORT.md](REPORT.md).

## Architecture

```
                      ┌──────────────── ALB ────────────────┐
 Client ──HTTP──▶     │  /        → EC2 ASG "obs-web"       │
                      │  /api/*   → ECS service "obs-app"   │
                      └─────────────────────────────────────┘
 EC2 web (httpd + CloudWatch Agent) ──▶ /obs/web/access, /obs/web/error, CWAgent metrics
 ECS app (Node.js + X-Ray sidecar)  ──▶ /obs/app (JSON logs), X-Ray traces
 RDS MySQL 8.4 (obs-db)             ──▶ error + slow query logs, Enhanced Monitoring, Database Insights

 Log groups ──subscription──▶ Firehose "obs-logs-to-s3" ──▶ S3 archive
 /obs/app ──metric filter──▶ ObsPlatform/ErrorCount

 Alarms ──▶ SNS "obs-oncall" (email)
        └─▶ EventBridge "obs-alarm-remediation" ──▶ Lambda "obs-remediator"
```

| Stack | Contents |
|---|---|
| `ObsWorkload` | VPC (2 AZs, no NAT gateway), ALB, EC2 Auto Scaling group `obs-web` (tag `Tier=web`), ECS cluster `obs-platform` with service `obs-app` (2 tasks + X-Ray daemon), RDS `obs-db` (db.t4g.medium, single-AZ) and 5 log groups |
| `ObsTelemetry` | S3 log archive, Firehose delivery stream, subscription filters, `ErrorCount` metric filter, 3 saved Logs Insights queries |
| `ObsResponse` | 3 alarms, SNS topic, EventBridge rule, remediation Lambda, `obs-platform` dashboard |

### Alarms and automated responses

| Alarm | Condition | Lambda action |
|---|---|---|
| `obs-ecs-cpu-high` | ECS CPU max > 80% for 2 of 2 one-minute periods | Forces a new ECS deployment, which replaces the tasks |
| `obs-app-error-count` | More than 10 `ERROR` log lines in 5 minutes | Tags running `Tier=web` instances with `investigate=true` |
| `obs-alb-5xx-rate` | ALB 5xx rate > 5% for 2 of 2 one-minute periods | Pages on-call by email. A human has to investigate. |

Every alarm also emails the `obs-oncall` SNS topic. The Lambda then sends a second email, `[obs] <alarm>: automated response`, that says what it did.

### Saved Logs Insights queries

- `obs/01-error-and-5xx-spikes`: errors and 5xx responses per minute and path
- `obs/02-slow-requests-with-trace-ids`: requests slower than 1 s, with the X-Ray trace ID for each
- `obs/03-rds-slow-queries`: entries from the RDS slow query log

## Repository layout

```
app/             Node.js API (Express, X-Ray SDK, JSON logs) and Dockerfile
web/             EC2 user data and CloudWatch Agent config
lambda/          remediator.py (alarm → action)
infrastructure/  CDK app (bin/infrastructure.ts, lib/*-stack.ts)
docs/screenshots Evidence
```

## Deploy

Prerequisites: Node.js 18+, Docker running, AWS CLI credentials for account 586481704498, and the account bootstrapped for CDK in eu-west-1.

```bash
cd infrastructure
npm ci
npx cdk deploy --all                                  # alerts go to the default email in response-stack.ts
npx cdk deploy --all -c alertEmail=you@example.com    # or send them somewhere else
```

CDK builds the API image from `app/` and pushes it during the deploy, so there's no separate image push. Confirm the SNS subscription email after the first deploy.

`cdk.context.json` is committed with the AZs pinned. This avoids an AZ lookup at synth time, which fails behind a TLS-intercepting proxy.

## Test endpoints

| Endpoint | Purpose |
|---|---|
| `/api/products` | Normal request with a DB query |
| `/api/slow?seconds=N` | `SELECT SLEEP(N)`: slow request, shows up in X-Ray and the RDS slow log |
| `/api/heavy?rounds=N` | `SELECT BENCHMARK(...)`: real DB CPU load for Database Insights |
| `/api/error` | Logs an `ERROR` line and returns 500 |
| `/api/cpu?seconds=N` | Burns CPU in the task |
| `/health`, `/api/health` | Health checks |

## Runbook

**`obs-ecs-cpu-high`:** The Lambda has already forced a new deployment. Check the ECS service events and confirm the new tasks are healthy. If CPU stays high on the new tasks, look at recent deploys and request volume on the dashboard.

**`obs-app-error-count`:** Run `obs/01-error-and-5xx-spikes` to find the failing path. Check the instances the Lambda tagged `investigate=true`. Remove the tag once you've finished.

**`obs-alb-5xx-rate`:** Check the dashboard to see whether 5xx comes from targets or the ALB itself. Check target health in both target groups. Follow trace IDs from `obs/02` into X-Ray.

Useful commands:

```bash
aws cloudwatch describe-alarm-history --alarm-name obs-ecs-cpu-high --history-item-type StateUpdate
aws logs tail /aws/lambda/obs-remediator --since 1h
aws ecs describe-services --cluster obs-platform --services obs-app --query 'services[0].events[0:6]'
```

## Evidence

| # | Screenshot | Shows |
|---|---|---|
| 01 | [dashboard-recovered](docs/screenshots/01-dashboard-recovered.png) | `obs-platform` dashboard, all alarms OK |
| 02 | [log-groups](docs/screenshots/02-log-groups.png) | The 5 log groups |
| 02b | [agent-metrics](docs/screenshots/02b-agent-metrics.png) | CloudWatch Agent metrics from the EC2 web tier |
| 03 | [firehose-s3](docs/screenshots/03-firehose-s3.png) | Logs delivered to the S3 archive by Firehose |
| 04 | [xray-trace-map](docs/screenshots/04-xray-trace-map.png) | X-Ray trace map: client → obs-app → MySQL |
| 04b | [xray-slow-trace](docs/screenshots/04b-xray-slow-trace.png) | A 2.00 s `/api/slow` trace with the SQL subsegment |
| 04c | [xray-trace-products](docs/screenshots/04c-xray-trace-products.png) | A normal `/api/products` trace |
| 05 | [slow-requests-query](docs/screenshots/05-slow-requests-query.png) | `obs/02` results with trace IDs |
| 05b | [rds-slow-query-log](docs/screenshots/05b-rds-slow-query-log.png) | Matching `Query_time: 2.0` entries in the RDS slow log |
| 05c | [database-insights](docs/screenshots/05c-database-insights.png) | Database Insights DB load during `/api/heavy` |
| 06 | [cpu-alarm-remediation](docs/screenshots/06-cpu-alarm-remediation.png) | CPU alarm → Lambda forced deployment → tasks replaced |
| 06a | [cpu-precheck](docs/screenshots/06a-cpu-precheck.png) | CPU alarm still OK before the test |
| 07 | [error-alarms-remediation](docs/screenshots/07-error-alarms-remediation.png) | Error and 5xx alarm history, Lambda actions, instance tagged |
| 07b | [dashboard-incident](docs/screenshots/07b-dashboard-incident.png) | Dashboard during the CPU and error tests |
| 08 | [error-spikes-query](docs/screenshots/08-error-spikes-query.png) | `obs/01` showing the error spike |
| 09 | [sns-emails](docs/screenshots/09-sns-emails.png) | Alarm and automated-response emails |

## Teardown

```bash
cd infrastructure
npx cdk destroy --all
```

The S3 archive bucket (auto-delete objects), the RDS instance and the CDK-defined log groups are removed with the stacks. AWS-created log groups such as `RDSOSMetrics` can be left behind. Check for them in eu-west-1 afterwards.
