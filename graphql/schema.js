const { createSchema } = require('graphql-yoga');
const { GraphQLError } = require('graphql');
const { supabase } = require('../config/supabase');

const typeDefs = /* GraphQL */ `
  type FoodItem {
    id: ID!
    name: String!
    description: String
    category: String!
    price: Float!
    imageUrl: String
    available: Boolean!
    createdAt: String
  }

  type Query {
    foodItem(id: ID!): FoodItem
    foodItems(
      category: String
      available: Boolean = true
      search: String
      limit: Int = 50
      offset: Int = 0
    ): [FoodItem!]!
  }
`;

function asNumber(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function assertAuth(context) {
  const expected = context?.env?.GRAPHQL_API_TOKEN;
  const authHeader = context?.request?.headers?.get('authorization') || '';
  const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : null;

  if (!expected) {
    throw new GraphQLError('GraphQL API token not configured', {
      extensions: { code: 'SERVER_MISCONFIGURATION' },
    });
  }

  if (!token || token !== expected) {
    throw new GraphQLError('Unauthorized', {
      extensions: { code: 'UNAUTHORIZED' },
    });
  }
}

const resolvers = {
  Query: {
    foodItem: async (_, { id }, context) => {
      assertAuth(context);

      const { data, error } = await supabase.from('food_items').select('*').eq('id', id).single();
      if (error) return null;
      return data;
    },

    foodItems: async (_, args, context) => {
      assertAuth(context);

      const {
        category,
        available = true,
        search,
        limit = 50,
        offset = 0,
      } = args || {};

      const safeLimit = Math.min(200, Math.max(1, limit));
      const safeOffset = Math.max(0, offset);

      let query = supabase
        .from('food_items')
        .select('*')
        .order('"createdAt"', { ascending: true })
        .range(safeOffset, safeOffset + safeLimit - 1);

      if (available !== null && available !== undefined) query = query.eq('available', available);
      if (category) query = query.eq('category', category);

      if (search && search.trim()) {
        const term = search.trim().replace(/%/g, '\\%').replace(/_/g, '\\_');
        query = query.or(`name.ilike.%${term}%,description.ilike.%${term}%`);
      }

      const { data, error } = await query;
      if (error) {
        throw new GraphQLError('Database error', {
          extensions: { code: 'DB_ERROR', details: error.message },
        });
      }

      // Normalize numeric types for GraphQL Float
      return (data || []).map((row) => ({
        ...row,
        price: asNumber(row.price),
      }));
    },
  },
};

const schema = createSchema({ typeDefs, resolvers });

module.exports = { schema };

