const { createClient } = require('@supabase/supabase-js');

const supabaseUrl     = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables: SUPABASE_URL and SUPABASE_ANON_KEY are required.');
}

// Public client (respects RLS) — used for order reads and food item reads
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Service client (bypasses RLS) — used for admin operations and order creation
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey, {
  auth: { persistSession: false }
});

module.exports = { supabase, supabaseAdmin };
