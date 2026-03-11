const { createYoga } = require('graphql-yoga');
const { schema } = require('./schema');

function createGraphQLServer() {
  return createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    context: ({ request }) => ({
      request,
      env: {
        GRAPHQL_API_TOKEN: process.env.GRAPHQL_API_TOKEN,
      },
    }),
  });
}

module.exports = { createGraphQLServer };

