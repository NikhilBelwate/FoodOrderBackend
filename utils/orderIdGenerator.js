/**
 * Generates a human-readable unique Order ID.
 * Format: ORD-{YYYYMMDD}-{HHmmss}-{RANDOM4}
 * Example: ORD-20260309-143522-A7F2
 */
const generateOrderId = () => {
  const now    = new Date();
  const date   = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time   = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const random = Math.random().toString(36).toUpperCase().slice(2, 6);
  return `ORD-${date}-${time}-${random}`;
};

module.exports = { generateOrderId };
