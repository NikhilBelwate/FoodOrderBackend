const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.GRAPHQL_API_TOKEN = 'test-token';

const app = require('../server');

test('GraphQL: rejects missing token', async () => {
  const res = await request(app)
    .post('/graphql')
    .send({ query: '{ foodItems { id } }' });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.errors));
  assert.equal(res.body.errors[0].extensions.code, 'UNAUTHORIZED');
});

test('GraphQL: rejects wrong token', async () => {
  const res = await request(app)
    .post('/graphql')
    .set('Authorization', 'Bearer wrong-token')
    .send({ query: '{ foodItems { id } }' });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.errors));
  assert.equal(res.body.errors[0].extensions.code, 'UNAUTHORIZED');
});

test('GraphQL: accepts correct token (may return DB error if Supabase not configured)', async () => {
  const res = await request(app)
    .post('/graphql')
    .set('Authorization', 'Bearer test-token')
    .send({
      query: 'query($limit:Int!){ foodItems(limit:$limit){ id name category price available } }',
      variables: { limit: 1 },
    });

  assert.equal(res.status, 200);
  // Either a successful data response or a DB_ERROR (if env vars/DB unavailable in CI/dev)
  if (res.body.errors?.length) {
    assert.equal(res.body.errors[0].extensions.code, 'DB_ERROR');
  } else {
    assert.ok(res.body.data);
    assert.ok(Array.isArray(res.body.data.foodItems));
  }
});

