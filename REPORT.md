# Capstone 7 Report: Observability-as-a-Service

**Author:** Emmanuel Mulala · **Region:** eu-west-1 · **Repo:** https://github.com/ManuelMulala/observability-platform

## 1. Design

The workload is an ALB in front of two compute tiers: an EC2 Auto Scaling group running httpd for `/`, and an ECS service running a Node.js API for `/api/*`. The API talks to an RDS MySQL 8.4 database. Each tier sends a different kind of telemetry:

- **Metrics:** ALB, ECS and RDS metrics come for free. The CloudWatch Agent on EC2 adds memory, disk and CPU (`CWAgent` namespace). The `ErrorCount` metric filter on `/obs/app` turns `ERROR` log lines into a metric.
- **Logs:** web access and error logs, JSON API logs, and the RDS error and slow query logs, all in CloudWatch Logs with 7-day retention. Subscription filters stream every group through Firehose to S3 for long-term storage.
- **Traces:** the API uses the X-Ray SDK with a daemon sidecar. MySQL calls appear as subsegments, and each request log line carries the trace ID, so a slow request found in the logs can be opened in X-Ray.
- **Database:** Enhanced Monitoring (60 s) and CloudWatch Database Insights, Standard mode.

Alarms notify an SNS topic and also trigger an EventBridge rule, which calls a Lambda that runs one action per alarm. High CPU forces a new ECS deployment. A high error count tags the web instances for investigation. A high 5xx rate pages a human, because no single automatic fix is safe for it.

**Region and cost choices.** I used eu-west-1 because the CDK bootstrap and GitHub connection already exist there. I didn't use af-south-1 because it's an opt-in region and costs more. There is no NAT gateway: tasks run in public subnets, ingress is allowed only from the ALB security group, and the database sits in isolated subnets. Running cost was about $0.14 per hour.

**Database instance size.** Performance Insights reached end of life and was replaced by Database Insights. Database Insights isn't supported on micro or small instances, so I used `db.t4g.medium` instead of `db.t4g.micro`. On this size Database Insights can't manage the Performance Schema itself, so I set `performance_schema = 1` in the parameter group and rebooted the database.

## 2. Correlation queries

| Query | Use |
|---|---|
| `obs/01-error-and-5xx-spikes` | Errors and 5xx per minute and path. This is the first step in an incident. |
| `obs/02-slow-requests-with-trace-ids` | Requests over 1 s with their X-Ray trace IDs |
| `obs/03-rds-slow-queries` | RDS slow log entries (`long_query_time = 1`) |

**Correlation check.** At 09:55:08–09:55:17 UTC I sent 5 requests to `/api/slow?seconds=2`. `obs/02` returned all 5 at about 2002 ms with their trace IDs. The X-Ray trace shows 2.00 s in the `mysql` subsegment, and the RDS slow log has 5 matching `Query_time: 2.0` entries at the same times. Logs, traces and database logs all point to the same cause.

## 3. Tests and results

All times are UTC (local time is UTC+3).

| Test | Trigger | Detected | Automated action | Recovered |
|---|---|---|---|---|
| CPU | `/api/cpu` burn from 11:13. CPU max 100.3% | `obs-ecs-cpu-high` ALARM 11:17:57 | 11:17:58 Lambda forced a new deployment. Old tasks stopped 11:19:25 and 11:19:45. Deployment completed 11:20:55. | CPU about 1% at 11:21. Alarm OK 11:24:57. |
| Errors | `/api/error` load from about 11:19 | `obs-app-error-count` ALARM 11:24:42 (28 errors in the window) | 11:24:44 tagged `i-0ff63933b82d0e7ac` with `investigate=true` | OK 11:38:42 |
| 5xx | Same load. 5xx rate 9.8% at 11:23, 24.4% at 11:24 | `obs-alb-5xx-rate` ALARM 11:27:08 | 11:27:08 paged on-call by email | OK 11:36:08 |

Every alarm sent two emails: the CloudWatch alarm email, and the Lambda's `[obs] <alarm>: automated response` email.

**Detection latency** was about 3–5 minutes. The CPU and 5xx alarms need 2 breaching one-minute periods, and the metrics themselves arrive late. I kept 2 of 2 because a single CPU spike during a deploy shouldn't replace healthy tasks. The cost is that a real incident is detected a few minutes later.

## 4. Real incidents during the build

These two incidents weren't planned. The platform caught both.

**Incident 1: broken web tier (09:04–09:36).** The user data script failed with `syntax error near unexpected token '}'` at line 40, so httpd and the CloudWatch Agent were never installed on the first web instance. About half the requests to `/` returned 502. `obs-alb-5xx-rate` went to ALARM at 09:11:08 and the Lambda paged at 09:11:09.

The cause was the CDK code that injected the agent config. It replaced the first occurrence of `__AGENT_CONFIG__`, and the first occurrence was in a header comment, not the heredoc. I fixed it with an anchored regex (`/^__AGENT_CONFIG__$/m`) and made synth fail if the placeholder is still there. Then I replaced the instance. The alarm returned to OK at 09:36:08.

**Incident 2: database reboot (about 10:36).** Rebooting RDS to turn on the Performance Schema made API calls fail for about a minute. The error count reached 20, `obs-app-error-count` went to ALARM at 10:37:42, and the Lambda tagged the web instance. The alarm cleared at 10:38:42.

## 5. Lessons learned

- **Validate generated scripts.** Running `bash -n` on the rendered user data would have caught incident 1 before deploy. A placeholder string should never also appear in a comment.
- **`SELECT SLEEP` produces no database load.** It makes requests slow and fills the slow log, but Database Insights showed nothing. `SELECT BENCHMARK` (`/api/heavy`) produced real DB CPU load.
- **Check what a managed feature supports.** Database Insights needs at least a medium instance, and on t4g.medium the Performance Schema has to be turned on by hand, which needs a reboot.
- **Choose alarm sensitivity deliberately.** Using 2 of 2 periods avoided false alarms but added minutes of detection time. Only some alarms can be fixed safely without a human.
- **Plan maintenance.** Even a planned reboot fired a real alarm, so maintenance should be announced or the alarm muted while it runs.
