// Checks on the synthesized templates that synth itself can't make. Run after `cdk synth`.
// Raw JSON properties (like a stage's RouteSettings) pass through synth unchecked, and a bad key or an
// unknown route only fails at deploy, where it rolls BridgeApi back.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const api = JSON.parse(readFileSync(new URL('./cdk.out/BridgeApi.template.json', import.meta.url)));
const resources = Object.values(api.Resources);
const routeKeys = new Set(resources.filter((r) => r.Type === 'AWS::ApiGatewayV2::Route').map((r) => r.Properties.RouteKey));
const known = new Set(['ThrottlingBurstLimit', 'ThrottlingRateLimit', 'LoggingLevel', 'DetailedMetricsEnabled', 'DataTraceEnabled']);
for (const stage of resources.filter((r) => r.Type === 'AWS::ApiGatewayV2::Stage')) {
  for (const [route, settings] of Object.entries(stage.Properties.RouteSettings ?? {})) {
    assert.ok(routeKeys.has(route), `RouteSettings names "${route}", which isn't a route`);
    for (const key of Object.keys(settings)) {
      assert.ok(known.has(key), `RouteSettings["${route}"].${key} isn't a CloudFormation property`);
    }
  }
}
console.log('templates ok');
