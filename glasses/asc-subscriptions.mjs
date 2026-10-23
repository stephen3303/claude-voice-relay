// Creates Bridge Pro in App Store Connect with the API key: the subscription group, the monthly
// and yearly subscriptions, their prices in every territory (Apple's equalized prices from the
// US price), availability, and a 1-week free trial. Safe to run again: it skips what exists, and brings an
// existing subscription's description and review note up to date.
//   ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_KEY_P8=path node glasses/asc-subscriptions.mjs
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BUNDLE_ID = 'com.talktobridge.bridge';
const GROUP = 'Bridge Pro';
const PLANS = [
  { productId: `${BUNDLE_ID}.pro.monthly`, name: 'Bridge Pro Monthly', period: 'ONE_MONTH', price: '4.99', level: 2,
    description: 'Natural voice and the Ask shortcut' },
  { productId: `${BUNDLE_ID}.pro.yearly`, name: 'Bridge Pro Yearly', period: 'ONE_YEAR', price: '49.99', level: 1,
    description: 'Natural voice and the Ask shortcut' },
];
const REVIEW_NOTE = 'Unlocks the natural cloud voice and the Ask Bridge Shortcuts action. Demo replies are built in: Settings > Connection > Connect to: Demo.';

const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 } = process.env;
const key = readFileSync(ASC_KEY_P8, 'utf8');

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' })}.${b64({ iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })}`;
  const sig = createSign('SHA256').update(body).sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${body}.${sig}`;
}

async function api(method, path, data) {
  const url = path.startsWith('http') ? path : `https://api.appstoreconnect.apple.com${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify({ data }) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  return json;
}

// Follows links.next so lists longer than one page come back whole.
async function all(path) {
  const out = [];
  for (let next = path; next; ) {
    const page = await api('GET', next);
    out.push(...page.data);
    next = page.links?.next;
  }
  return out;
}

const rel = (type, id) => ({ data: { type, id } });

const [app] = (await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}`)).data;
if (!app) throw new Error(`No app with bundle ID ${BUNDLE_ID}: create it in App Store Connect > Apps > + first`);
console.log(`app ${app.id} ${app.attributes.name}`);

let group = (await all(`/v1/apps/${app.id}/subscriptionGroups`)).find((g) => g.attributes.referenceName === GROUP);
if (!group) {
  group = (await api('POST', '/v1/subscriptionGroups', {
    type: 'subscriptionGroups', attributes: { referenceName: GROUP }, relationships: { app: rel('apps', app.id) },
  })).data;
  await api('POST', '/v1/subscriptionGroupLocalizations', {
    type: 'subscriptionGroupLocalizations', attributes: { locale: 'en-US', name: GROUP },
    relationships: { subscriptionGroup: rel('subscriptionGroups', group.id) },
  });
  console.log(`created group ${group.id}`);
}

const territories = (await all('/v1/territories?limit=200')).map((t) => t.id);
const existing = await all(`/v1/subscriptionGroups/${group.id}/subscriptions`);

for (const plan of PLANS) {
  let sub = existing.find((s) => s.attributes.productId === plan.productId);
  if (!sub) {
    sub = (await api('POST', '/v1/subscriptions', {
      type: 'subscriptions',
      attributes: { name: plan.name, productId: plan.productId, subscriptionPeriod: plan.period,
        familySharable: false, groupLevel: plan.level,
        reviewNote: REVIEW_NOTE },
      relationships: { group: rel('subscriptionGroups', group.id) },
    })).data;
    await api('POST', '/v1/subscriptionLocalizations', {
      type: 'subscriptionLocalizations', attributes: { locale: 'en-US', name: plan.name, description: plan.description },
      relationships: { subscription: rel('subscriptions', sub.id) },
    });
    console.log(`created ${plan.productId} ${sub.id}`);
  } else {
    // An existing subscription keeps what Pro used to promise unless its texts are brought up to date.
    if (sub.attributes.reviewNote !== REVIEW_NOTE) {
      // Apple can refuse this once the subscription is in review or approved; the description still gets updated.
      try {
        await api('PATCH', `/v1/subscriptions/${sub.id}`, { type: 'subscriptions', id: sub.id, attributes: { reviewNote: REVIEW_NOTE } });
        console.log(`updated the review note of ${plan.productId}`);
      } catch (e) {
        console.warn(`::warning::couldn't update the review note of ${plan.productId}: ${e.message}`);
      }
    }
    const loc = (await all(`/v1/subscriptions/${sub.id}/subscriptionLocalizations`)).find((l) => l.attributes.locale === 'en-US');
    if (!loc) {
      await api('POST', '/v1/subscriptionLocalizations', {
        type: 'subscriptionLocalizations', attributes: { locale: 'en-US', name: plan.name, description: plan.description },
        relationships: { subscription: rel('subscriptions', sub.id) },
      });
      console.log(`added the description of ${plan.productId}`);
    } else if (loc.attributes.description !== plan.description || loc.attributes.name !== plan.name) {
      await api('PATCH', `/v1/subscriptionLocalizations/${loc.id}`, {
        type: 'subscriptionLocalizations', id: loc.id, attributes: { name: plan.name, description: plan.description },
      });
      console.log(`updated the description of ${plan.productId}`);
    }
  }

  // Availability first: prices and offers can only be set in territories it is sold in.
  const avail = await api('GET', `/v1/subscriptions/${sub.id}/subscriptionAvailability`).catch(() => null);
  if (!avail?.data) {
    await api('POST', '/v1/subscriptionAvailabilities', {
      type: 'subscriptionAvailabilities', attributes: { availableInNewTerritories: true },
      relationships: { subscription: rel('subscriptions', sub.id),
        availableTerritories: { data: territories.map((id) => ({ type: 'territories', id })) } },
    });
    console.log(`  available in ${territories.length} territories`);
  }

  // Prices: the US price point, then Apple's equalized price for every other territory.
  const priced = new Set((await all(`/v1/subscriptions/${sub.id}/prices?include=territory&limit=200`))
    .map((p) => p.relationships?.territory?.data?.id).filter(Boolean));
  if (priced.size < territories.length) {
    const usPoints = await all(`/v1/subscriptions/${sub.id}/pricePoints?filter[territory]=USA&limit=200`);
    const us = usPoints.find((p) => p.attributes.customerPrice === plan.price);
    if (!us) throw new Error(`No US price point at $${plan.price}`);
    const points = [us, ...await all(`/v1/subscriptionPricePoints/${us.id}/equalizations?include=territory&limit=200`)];
    let added = 0;
    for (const point of points) {
      const territory = point.relationships?.territory?.data?.id ?? 'USA';
      if (priced.has(territory)) continue;
      await api('POST', '/v1/subscriptionPrices', {
        type: 'subscriptionPrices', attributes: { preserveCurrentPrice: false },
        relationships: { subscription: rel('subscriptions', sub.id),
          subscriptionPricePoint: rel('subscriptionPricePoints', point.id), territory: rel('territories', territory) },
      });
      added++;
    }
    console.log(`  priced at $${plan.price} (+${added} territories)`);
  }

  // A 1-week free trial in each territory.
  const offered = new Set((await all(`/v1/subscriptions/${sub.id}/introductoryOffers?include=territory&limit=200`))
    .map((o) => o.relationships?.territory?.data?.id).filter(Boolean));
  let offers = 0;
  for (const territory of territories) {
    if (offered.has(territory)) continue;
    await api('POST', '/v1/subscriptionIntroductoryOffers', {
      type: 'subscriptionIntroductoryOffers', attributes: { duration: 'ONE_WEEK', offerMode: 'FREE_TRIAL', numberOfPeriods: 1 },
      relationships: { subscription: rel('subscriptions', sub.id), territory: rel('territories', territory) },
    }).then(() => offers++, (e) => console.log(`  trial skipped in ${territory}: ${e.message.slice(0, 120)}`));
  }
  if (offers) console.log(`  1-week free trial in ${offers} territories`);
}

console.log('Bridge Pro is set up. Still needed in App Store Connect: a review screenshot of the paywall for each subscription.');
