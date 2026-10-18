// Checks on the synthesized templates that synth itself can't make. Run after `cdk synth`.
// Raw JSON properties (like the stage's RouteSettings) pass through synth unchecked, and a wrong key
// only fails at deploy, where it rolls BridgeApi back.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const api = JSON.parse(readFileSync(new URL('./cdk.out/BridgeApi.template.json', import.meta.url)));
const stages = Object.values(api.Resources).filter((r) => r.Type === 'AWS::ApiGatewayV2::Stage');
assert.equal(stages.length, 1, 'expected one API stage');
const known = new Set(['ThrottlingBurstLimit', 'ThrottlingRateLimit', 'LoggingLevel', 'DetailedMetricsEnabled', 'DataTraceEnabled']);
for (const [route, settings] of Object.entries(stages[0].Properties.RouteSettings ?? {})) {
  for (const key of Object.keys(settings)) {
    assert.ok(known.has(key), `RouteSettings["${route}"].${key} isn't a CloudFormation property`);
  }
}
console.log('templates ok');
