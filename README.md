# FoodOrder Backend

Express.js backend for a Food Ordering app, backed by Supabase.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and fill in values:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY` (recommended)
- `GRAPHQL_API_TOKEN` (static token used to access `/graphql`)

3. Run the server:

```bash
npm run dev
```

Health check: `GET /health`

## GraphQL API

- **Endpoint**: `POST /graphql` (GraphiQL is available at the same URL in dev)
- **Auth**: static Bearer token

Send a header:

```text
Authorization: Bearer <GRAPHQL_API_TOKEN>
```

### Query: foodItems (filter “on demand”)

Supported arguments:
- `category` (String)
- `available` (Boolean, default `true`)
- `search` (String, matches name/description)
- `limit` (Int, default `50`, max `200`)
- `offset` (Int, default `0`)

Example (curl):

```bash
curl -s http://localhost:5000/graphql ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer change_me_dev_token" ^
  -d "{\"query\":\"query($c:String,$q:String){ foodItems(category:$c, search:$q, limit:10){ id name category price available } }\",\"variables\":{\"c\":\"Pizza\",\"q\":\"pepper\"}}"
```

Example query:

```graphql
query {
  foodItems(category: "Pizza", search: "pepper", limit: 10) {
    id
    name
    category
    price
    available
  }
}
```

### Query: foodItem

```graphql
query ($id: ID!) {
  foodItem(id: $id) {
    id
    name
    description
    category
    price
    imageUrl
    available
  }
}
```

## Tests

Run:

```bash
npm test
```

The GraphQL tests validate:
- requests without a token are rejected (`UNAUTHORIZED`)
- requests with the wrong token are rejected (`UNAUTHORIZED`)
- requests with the correct token reach the resolver (it may return `DB_ERROR` if Supabase isn’t configured/running)

