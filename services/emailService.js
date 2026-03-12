/**
 * emailService.js — Delivery notification emails via Gmail SMTP
 *
 * Uses Node.js built-in `tls` module — no external packages required.
 * Gmail SMTP over SSL (port 465) with AUTH LOGIN (App Password).
 *
 * Required env vars:
 *   GMAIL_USER          — sender Gmail address (e.g. admin@gmail.com)
 *   GMAIL_APP_PASSWORD  — 16-character Gmail App Password (not your Gmail login password)
 *   GMAIL_FROM_NAME     — display name in From header (default: 'FoodOrder')
 *
 * Setup guide (see admin.js header comment for link):
 *   1. Enable 2-Step Verification on your Google Account
 *   2. Go to myaccount.google.com → Security → App Passwords
 *   3. Generate a new App Password for "Mail" + "Other device"
 *   4. Copy the 16-char code into GMAIL_APP_PASSWORD in .env
 */

'use strict';

const tls = require('tls');

// ─── Low-level SMTP-over-TLS client ──────────────────────────────────────────

function smtpSend({ host, port, from, password, to, subject, htmlBody }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(port, host, { rejectUnauthorized: true });

    let lineBuffer = '';
    const pendingLines  = [];   // lines received but not yet consumed
    const lineResolvers = [];   // callbacks waiting for the next line

    // Push an incoming SMTP line to whoever is waiting, or queue it
    function pushLine(line) {
      if (lineResolvers.length > 0) {
        lineResolvers.shift()(null, line);
      } else {
        pendingLines.push(line);
      }
    }

    // Return a promise that resolves with the next complete SMTP line
    function nextLine() {
      return new Promise((res, rej) => {
        if (pendingLines.length > 0) {
          res(pendingLines.shift());
        } else {
          lineResolvers.push((err, line) => (err ? rej(err) : res(line)));
        }
      });
    }

    socket.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      let idx;
      while ((idx = lineBuffer.indexOf('\r\n')) >= 0) {
        const line = lineBuffer.slice(0, idx);
        lineBuffer  = lineBuffer.slice(idx + 2);
        if (line) pushLine(line);
      }
    });

    socket.on('error', (err) => {
      lineResolvers.forEach((fn) => fn(err));
      lineResolvers.length = 0;
      reject(new Error('SMTP socket error: ' + err.message));
    });

    // Read SMTP response, skipping continuation lines (250-...) until final line (250 ...)
    async function readResponse(expectedCode) {
      while (true) {
        const line = await nextLine();
        const code  = parseInt(line.slice(0, 3), 10);
        const isCont = line[3] === '-';
        if (!isCont) {
          if (expectedCode && code !== expectedCode) {
            throw new Error(`SMTP ${code}: ${line.slice(4).trim()}`);
          }
          return { code, text: line.slice(4).trim() };
        }
        // continuation line — keep reading
      }
    }

    // Send a command and optionally assert the response code
    async function cmd(command, expectedCode) {
      socket.write(command + '\r\n');
      return readResponse(expectedCode);
    }

    // Wrap base64 to 76-char lines as required by MIME spec
    function base64Wrap(str) {
      const b64 = Buffer.from(str, 'utf8').toString('base64');
      return b64.match(/.{1,76}/g).join('\r\n');
    }

    async function run() {
      // 1. Server greeting
      await readResponse(220);

      // 2. EHLO
      await cmd('EHLO foodorder.local', 250);

      // 3. AUTH LOGIN — base64-encoded username then password
      await cmd('AUTH LOGIN', 334);
      await cmd(Buffer.from(from).toString('base64'), 334);
      await cmd(Buffer.from(password).toString('base64'), 235);

      // 4. Envelope
      await cmd(`MAIL FROM:<${from}>`, 250);
      await cmd(`RCPT TO:<${to}>`,    250);

      // 5. Send DATA
      await cmd('DATA', 354);

      const fromName = process.env.GMAIL_FROM_NAME || 'FoodOrder';
      const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
      const body64 = base64Wrap(htmlBody);

      const rawMessage = [
        `From: ${fromName} <${from}>`,
        `To: ${to}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        body64,
      ].join('\r\n');

      // Terminate DATA block with <CRLF>.<CRLF>
      socket.write(rawMessage + '\r\n.\r\n');
      await readResponse(250);

      // 6. Quit gracefully
      socket.write('QUIT\r\n');
      socket.destroy();
      resolve({ success: true });
    }

    run().catch((err) => {
      socket.destroy();
      reject(err);
    });
  });
}

// ─── HTML email template ─────────────────────────────────────────────────────

function buildDeliveryEmail(order) {
  const items       = order.order_items || [];
  const address     = order['deliveryAddress'] || '';
  const mapsUrl     = address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
    : null;
  const orderedAt   = order['createdAt']
    ? new Date(order['createdAt']).toLocaleString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : '';
  const deliveredAt = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // ── Build items rows ──────────────────────────────────────────────────────
  const itemRows = items.map((item) => {
    const unitPrice   = parseFloat(item.price || 0);
    const qty         = item.quantity || 1;
    const subtotal    = (unitPrice * qty).toFixed(2);
    const food        = item.food_items || {};
    const discountPct = parseFloat(food.discount_percent || 0);
    const offerLabel  = food.offer_label || (discountPct > 0 ? `${discountPct}% off` : '');

    const offerBadge = offerLabel
      ? `<span style="display:inline-block;margin-top:4px;padding:2px 8px;background:#dcfce7;color:#166534;border-radius:999px;font-size:11px;font-weight:600;">${offerLabel}</span>`
      : '';

    return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;vertical-align:top;">
          <div style="font-weight:600;color:#111827;">${food.name || 'Item'}</div>
          <div style="font-size:12px;color:#9ca3af;margin-top:2px;">${food.category || ''}</div>
          ${offerBadge}
        </td>
        <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;text-align:center;color:#374151;">${qty}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;text-align:right;color:#374151;">$${unitPrice.toFixed(2)}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:600;color:#111827;">$${subtotal}</td>
      </tr>`;
  }).join('');

  // ── Special instructions ──────────────────────────────────────────────────
  const specialInstr = order['specialInstructions']
    ? `
      <div style="margin-top:24px;">
        <h3 style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;">Special Instructions</h3>
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;font-size:14px;color:#92400e;">
          ${order['specialInstructions']}
        </div>
      </div>`
    : '';

  // ── Delivery address ──────────────────────────────────────────────────────
  const addressSection = address
    ? `<p style="margin:4px 0 0;font-size:14px;color:#374151;">${address}</p>
       ${mapsUrl ? `<a href="${mapsUrl}" style="display:inline-block;margin-top:6px;font-size:13px;color:#2563eb;text-decoration:none;font-weight:600;">🗺️ Open in Google Maps →</a>` : ''}`
    : `<p style="margin:4px 0 0;font-size:14px;color:#9ca3af;">Not specified</p>`;

  // ── Full HTML ─────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Order Delivered!</title>
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <!-- Outer wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 16px;">
    <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

      <!-- Header -->
      <tr>
        <td style="background:linear-gradient(135deg,#f97316,#ea580c);border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
          <div style="font-size:40px;margin-bottom:8px;">🛵</div>
          <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Your Order Has Been Delivered!</h1>
          <p style="margin:8px 0 0;color:#fed7aa;font-size:15px;">We hope you enjoy your meal 🎉</p>
        </td>
      </tr>

      <!-- Body card -->
      <tr>
        <td style="background:#ffffff;border-radius:0 0 16px 16px;padding:32px 40px;border:1px solid #e5e7eb;border-top:none;">

          <!-- Greeting -->
          <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#111827;">
            Hi ${order['customerName'] || 'Valued Customer'} 👋
          </p>
          <p style="margin:0 0 24px;font-size:15px;color:#6b7280;line-height:1.6;">
            Great news — your order <strong style="color:#f97316;">${order['orderId'] || order.id}</strong>
            has just been delivered at <strong>${deliveredAt}</strong>.
            We'd love to hear about your experience!
          </p>

          <!-- Order Summary pill -->
          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9a3412;">Order ID</div>
                  <div style="font-size:15px;font-weight:700;color:#111827;font-family:monospace;margin-top:2px;">${order['orderId'] || order.id}</div>
                </td>
                <td align="right">
                  <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9a3412;">Placed On</div>
                  <div style="font-size:14px;color:#374151;margin-top:2px;">${orderedAt}</div>
                </td>
              </tr>
            </table>
          </div>

          <!-- Customer info -->
          <h3 style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;">Customer Details</h3>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:12px;padding:4px;margin-bottom:24px;">
            <tr>
              <td style="padding:10px 16px;width:50%;vertical-align:top;">
                <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Name</div>
                <div style="font-size:14px;font-weight:600;color:#111827;margin-top:2px;">${order['customerName'] || '—'}</div>
              </td>
              <td style="padding:10px 16px;vertical-align:top;">
                <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Email</div>
                <div style="font-size:14px;color:#374151;margin-top:2px;word-break:break-all;">${order['customerEmail'] || '—'}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 16px;border-top:1px solid #e5e7eb;vertical-align:top;">
                <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Phone</div>
                <div style="font-size:14px;color:#374151;margin-top:2px;">${order['customerPhone'] || '—'}</div>
              </td>
              <td style="padding:10px 16px;border-top:1px solid #e5e7eb;vertical-align:top;">
                <div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Status</div>
                <div style="display:inline-block;margin-top:4px;padding:2px 10px;background:#dcfce7;color:#166534;border-radius:999px;font-size:12px;font-weight:700;">✅ Delivered</div>
              </td>
            </tr>
          </table>

          <!-- Delivery address -->
          <h3 style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;">Delivery Address</h3>
          <div style="background:#f9fafb;border-radius:12px;padding:14px 16px;margin-bottom:24px;">
            <span style="font-size:18px;">📍</span>
            ${addressSection}
          </div>

          ${specialInstr}

          <!-- Items table -->
          <h3 style="margin:24px 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;">Items Ordered (${items.length})</h3>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:10px 16px;text-align:left;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Item</th>
                <th style="padding:10px 16px;text-align:center;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Qty</th>
                <th style="padding:10px 16px;text-align:right;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Price</th>
                <th style="padding:10px 16px;text-align:right;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              ${itemRows}
            </tbody>
          </table>

          <!-- Total -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:0;background:#fff7ed;border:1px solid #fed7aa;border-top:none;border-radius:0 0 12px 12px;">
            <tr>
              <td style="padding:14px 16px;">
                <span style="font-size:15px;font-weight:700;color:#374151;">Total Amount</span>
              </td>
              <td style="padding:14px 16px;text-align:right;">
                <span style="font-size:22px;font-weight:800;color:#f97316;">$${parseFloat(order['totalPrice'] || 0).toFixed(2)}</span>
              </td>
            </tr>
          </table>

          <!-- Thank you message -->
          <div style="margin-top:32px;text-align:center;padding:24px 32px;background:linear-gradient(135deg,#fff7ed,#fef3c7);border-radius:16px;border:1px solid #fed7aa;">
            <div style="font-size:32px;margin-bottom:8px;">🙏</div>
            <h2 style="margin:0 0 8px;font-size:20px;font-weight:800;color:#92400e;">Thank You for Your Order!</h2>
            <p style="margin:0;font-size:14px;color:#78350f;line-height:1.7;">
              We truly appreciate your trust in us. It was our pleasure to prepare and deliver your meal.
              We hope every bite brings you joy! 😊
            </p>
            <p style="margin:12px 0 0;font-size:14px;color:#78350f;line-height:1.6;">
              We look forward to serving you again soon.<br>
              <strong>— The FoodOrder Team</strong>
            </p>
          </div>

          <!-- Footer -->
          <div style="margin-top:28px;text-align:center;border-top:1px solid #f3f4f6;padding-top:20px;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">
              This is an automated delivery confirmation. Please do not reply to this email.<br>
              Questions? Contact us at <a href="mailto:${process.env.GMAIL_USER}" style="color:#f97316;">${process.env.GMAIL_USER}</a>
            </p>
            <p style="margin:8px 0 0;font-size:11px;color:#d1d5db;">© ${new Date().getFullYear()} FoodOrder · All rights reserved</p>
          </div>

        </td>
      </tr>
    </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an order delivery notification email to the customer.
 * @param {object} order  Full order object with nested order_items → food_items
 * @returns {Promise<{success: boolean}>}
 */
async function sendDeliveryNotification(order) {
  const gmailUser     = process.env.GMAIL_USER;
  const gmailPassword = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPassword) {
    throw new Error(
      'Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env'
    );
  }

  const customerEmail = order['customerEmail'];
  if (!customerEmail) {
    throw new Error('Order has no customer email address');
  }

  const orderId  = order['orderId'] || order.id;
  const subject  = `Your order ${orderId} has been delivered! 🎉`;
  const htmlBody = buildDeliveryEmail(order);

  return smtpSend({
    host:     'smtp.gmail.com',
    port:     465,
    from:     gmailUser,
    password: gmailPassword,
    to:       customerEmail,
    subject,
    htmlBody,
  });
}

module.exports = { sendDeliveryNotification };
