import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixtureEvent {
  t: string
  type: 'sign-in' | 'sign-in-refused' | 'order-created' | 'order-deleted' | 'photo-uploaded' | 'spot' | 'server-error' | 'setting-saved'
  account?: string
  detail: Record<string, unknown>
}

interface Order {
  id: string
  customer: string
  quantity: number
  delivery: string
  notes: string
  createdBy: string
}

export interface FixtureApp {
  url: string
  port: number
  events(): FixtureEvent[]
  reset(): void
  close(): Promise<void>
}

const SEED: Omit<Order, 'id'>[] = [
  { customer: 'José Álvarez', quantity: 3, delivery: '2026-11-02', notes: 'Leave at the back door', createdBy: 'seed' },
  { customer: 'Mia Chen', quantity: 1, delivery: '2026-11-05', notes: '', createdBy: 'seed' },
  { customer: 'Oliver Brown', quantity: 12, delivery: '2026-11-09', notes: 'Call first', createdBy: 'seed' },
]

/** The spot to mark on the canvas, in canvas pixels. */
export const SPOT = { x: 220, y: 120, radius: 14 }

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

function layout(title: string, body: string, account?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Kiln Orders</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d2329;--muted:#5f6b74;--line:#d9d6cf;--accent:#1f6f5c;--danger:#b42318}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);background:#fff;flex-wrap:wrap}
header a{color:var(--fg);text-decoration:none}header strong{margin-right:auto}
main{max-width:760px;margin:0 auto;padding:20px}
label{display:block;font-weight:600;margin:14px 0 4px}input,select,textarea{font:inherit;padding:8px;border:1px solid var(--line);border-radius:4px;width:100%;max-width:420px}
button{font:inherit;padding:8px 16px;border:0;border-radius:4px;background:var(--accent);color:#fff;cursor:pointer}
.list{list-style:none;padding:0}.list li{padding:10px 0;border-bottom:1px solid var(--line)}.muted{color:var(--muted)}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1d2329;color:#fff;padding:10px 16px;border-radius:6px;display:none}
.del{width:12px;height:12px;padding:0;font-size:10px;line-height:12px;background:var(--danger)}
canvas{border:1px solid var(--line);background:#fff;touch-action:none}
</style></head><body>
<header><strong>Kiln Orders</strong>${account ? `<a href="/">Orders</a><a href="/settings">Settings</a><a href="/sign-out">Sign out (${escapeHtml(account)})</a>` : ''}</header>
<main>${body}</main><div id="toast" role="status"></div>
<script>function toast(t){var e=document.getElementById('toast');e.textContent=t;e.style.display='block';clearTimeout(window.__t);window.__t=setTimeout(function(){e.style.display='none'},4000)}</script>
</body></html>`
}

function signInPage(): string {
  return layout(
    'Sign in',
    `<h1>Sign in</h1><form id="f"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
<p><button type="submit">Sign in</button></p><p id="err" role="alert" style="color:#b42318"></p></form>
<script>document.getElementById('f').onsubmit=async function(e){e.preventDefault();var r=await fetch('/api/sign-in',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email.value,password:password.value})});if(r.ok)location.href='/';else{var j=await r.json();document.getElementById('err').textContent=j.message}}</script>`,
  )
}

function dashboard(orders: Order[], account: string, q: string): string {
  const items = orders
    .map((o) => `<li><a href="/orders/${o.id}">${escapeHtml(o.customer)}</a> <span class="muted">· ${o.quantity} items · ${o.delivery}</span></li>`)
    .join('')
  return layout(
    'Orders',
    `<h1>Orders</h1><form method="get" action="/" role="search"><label for="q">Search customers</label><input id="q" name="q" value="${escapeHtml(q)}" placeholder="Name"> <button type="submit">Search</button></form>
<p><a href="/orders/new"><button type="button">New order</button></a></p>
<p class="muted">${orders.length} ${orders.length === 1 ? 'order' : 'orders'}</p><ul class="list">${items || '<li class="muted">No orders match.</li>'}</ul>`,
    account,
  )
}

function newOrderPage(account: string): string {
  return layout(
    'New order',
    `<h1>New order</h1><form id="f"><label for="customer">Customer name</label><input id="customer" required>
<label for="quantity">Quantity</label><input id="quantity" type="number" min="0" value="1">
<label for="delivery">Delivery date</label><input id="delivery" type="date">
<label for="notes">Notes</label><textarea id="notes" rows="3"></textarea>
<p><button id="save" type="submit">Save order</button></p></form>
<script>
document.getElementById('f').onsubmit=async function(e){e.preventDefault();
 var name=customer.value.trim(); if(!name){toast('Enter the customer name');return}
 if(name.length>40) return; // planted: silent-long-name
 var r=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customer:name,quantity:Number(quantity.value),delivery:delivery.value||'2026-12-01',notes:notes.value})});
 if(r.status>=500){document.open();document.write(await r.text());document.close();return} // planted: crash-on-zero
 var j=await r.json(); if(!r.ok){toast(j.message);return} toast('Order saved'); setTimeout(function(){location.href='/orders/'+j.id},600)};
</script>`,
    account,
  )
}

function orderPage(order: Order, account: string): string {
  const delivery = new Date(`${order.delivery}T00:00:00Z`).toISOString() // planted: raw-date
  return layout(
    order.customer,
    `<h1>${escapeHtml(order.customer)}</h1><p><button class="del" aria-label="Delete order" id="del">×</button></p>
<dl><dt>Quantity</dt><dd>${order.quantity}</dd><dt>Delivery</dt><dd>${delivery}</dd><dt>Notes</dt><dd>${escapeHtml(order.notes) || '<span class="muted">None</span>'}</dd></dl>
<h2>Photo of the goods</h2><label for="photo">Upload a photo (PNG or JPEG)</label><input id="photo" type="file" accept="image/png,image/jpeg">
<h2>Mark the delivery spot</h2><p class="muted">Click the red circle on the map.</p><canvas id="map" width="300" height="200" aria-label="Delivery map"></canvas>
<script>
var c=document.getElementById('map'),x=c.getContext('2d');x.fillStyle='#e8eef0';x.fillRect(0,0,300,200);x.strokeStyle='#9aa';for(var i=0;i<300;i+=30){x.beginPath();x.moveTo(i,0);x.lineTo(i,200);x.stroke()}
x.fillStyle='#d23';x.beginPath();x.arc(${SPOT.x},${SPOT.y},${SPOT.radius},0,7);x.fill();
c.addEventListener('click',async function(e){var b=c.getBoundingClientRect();var r=await fetch('/api/spot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({order:'${order.id}',x:Math.round(e.clientX-b.left),y:Math.round(e.clientY-b.top)})});var j=await r.json();toast(j.hit?'Spot marked':'That is not the delivery spot')});
document.getElementById('del').onclick=async function(){if(!confirm('Delete this order?'))return;await fetch('/api/orders/${order.id}',{method:'DELETE'});location.href='/'};
document.getElementById('photo').onchange=async function(){var f=this.files[0];if(!f)return;if(!/^image\\/(png|jpeg)$/.test(f.type)){toast('Only PNG or JPEG photos');return}var r=await fetch('/api/orders/${order.id}/photo',{method:'POST',headers:{'content-type':f.type},body:f});var j=await r.json();toast(r.ok?'Photo uploaded ('+j.kb+' KB)':j.message)};
</script>`,
    account,
  )
}

/** Another origin, for links, redirects and pop-ups that leave the app (nothing listens there). */
export const ELSEWHERE = 'http://127.0.0.1:9'

function settingsPage(account: string, language: string): string {
  return layout(
    'Settings',
    `<h1>Settings</h1><label for="lang">Language</label><select id="lang"><option value="en"${language === 'en' ? ' selected' : ''}>English</option><option value="es"${language === 'es' ? ' selected' : ''}>Español</option></select>
<label><input type="checkbox" id="dark" style="width:auto"> Dark mode</label>
<label id="remind-label">Reminder</label><button id="remind" type="button" role="combobox" aria-labelledby="remind-label" aria-haspopup="listbox" aria-expanded="false" aria-controls="remind-list">None</button>
<ul id="remind-list" role="listbox" aria-labelledby="remind-label" hidden><li role="option" aria-selected="true">None</li><li role="option" aria-selected="false">1 day before</li><li role="option" aria-selected="false">1 week before</li></ul>
<h2>Help</h2><p><a href="${ELSEWHERE}/help">Help centre</a> · <a href="/help/portal">Supplier portal</a> · <button id="chat" type="button">Open chat</button></p>
<script>
chat.onclick=function(){window.open('${ELSEWHERE}/chat')};
var remindList=document.getElementById('remind-list');
remind.onclick=function(){var opening=remindList.hidden;remindList.hidden=!opening;remind.setAttribute('aria-expanded',String(opening))};
remindList.querySelectorAll('[role=option]').forEach(function(o){o.onclick=function(){remind.textContent=o.textContent;remindList.hidden=true;remind.setAttribute('aria-expanded','false');remindList.querySelectorAll('[role=option]').forEach(function(p){p.setAttribute('aria-selected',String(p===o))});toast('Reminder: '+o.textContent)}});
lang.onchange=async function(){await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({language:lang.value})});toast('Saved')};
dark.onchange=function(){var prefs=null;prefs.theme=dark.checked?'dark':'light'}; // planted: dark-mode-crash
</script>`,
    account,
  )
}

async function readBody(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function startFixtureApp(options: { port?: number; host?: string } = {}): Promise<FixtureApp> {
  let orders: Order[] = []
  let events: FixtureEvent[] = []
  const languages = new Map<string, string>()
  const reset = () => {
    orders = SEED.map((order) => ({ ...order, id: randomUUID() }))
    events = []
    languages.clear()
  }
  reset()
  const log = (type: FixtureEvent['type'], account: string | undefined, detail: Record<string, unknown> = {}) =>
    events.push({ t: new Date().toISOString(), type, ...(account ? { account } : {}), detail })

  const server: Server = createServer(async (req, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    const account = /(?:^|;\s*)fx_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    const user = account ? decodeURIComponent(account) : undefined
    const html = (status: number, body: string) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body)
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    try {
      if (url.pathname === '/__fixture/events') return json(200, events)
      // A page whose button never returns (an endless loop): how the harness copes with a frozen app.
      if (url.pathname === '/__fixture/freeze') return html(200, '<!doctype html><title>Freeze</title><button onclick="for (;;) {}">Freeze</button>')
      if (url.pathname === '/__fixture/reset' && req.method === 'POST') {
        reset()
        return json(200, { ok: true })
      }
      if (url.pathname === '/sign-in') return html(200, signInPage())
      if (url.pathname === '/api/sign-in' && req.method === 'POST') {
        const { email = '', password = '' } = JSON.parse((await readBody(req)).toString() || '{}')
        if (!/^[^@\s]+@fixture\.test$/i.test(email) || !password) {
          log('sign-in-refused', email)
          return json(401, { message: 'Unknown account or empty password.' })
        }
        log('sign-in', email.toLowerCase())
        res.setHeader('set-cookie', `fx_session=${encodeURIComponent(email.toLowerCase())}; Path=/; HttpOnly; SameSite=Lax`)
        return json(200, { ok: true })
      }
      if (url.pathname === '/sign-out') {
        res.setHeader('set-cookie', 'fx_session=; Path=/; Max-Age=0')
        res.writeHead(302, { location: '/sign-in' }).end()
        return
      }
      if (!user) {
        if (url.pathname.startsWith('/api/')) return json(401, { message: 'Sign in first.' })
        res.writeHead(302, { location: '/sign-in' }).end()
        return
      }
      if (url.pathname === '/' && req.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim()
        // planted: search-accents (no diacritic folding)
        const shown = q ? orders.filter((o) => o.customer.toLowerCase().includes(q.toLowerCase())) : orders
        return html(200, dashboard(shown, user, q))
      }
      if (url.pathname === '/orders/new') return html(200, newOrderPage(user))
      if (url.pathname === '/help/portal') {
        res.writeHead(302, { location: `${ELSEWHERE}/portal` }).end()
        return
      }
      if (url.pathname === '/settings') return html(200, settingsPage(user, languages.get(user) ?? 'en'))
      const orderMatch = /^\/orders\/([0-9a-f-]{36})$/.exec(url.pathname)
      if (orderMatch) {
        const order = orders.find((o) => o.id === orderMatch[1])
        return order ? html(200, orderPage(order, user)) : html(404, layout('Not found', '<h1>Order not found</h1>', user))
      }
      if (url.pathname === '/api/orders' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}')
        if (Number(body.quantity) === 0) {
          log('server-error', user, { route: 'POST /api/orders', reason: 'quantity 0' })
          res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal Server Error\nTypeError: Cannot divide by zero quantity')
          return
        }
        if (!body.customer || Number(body.quantity) < 0) return json(400, { message: 'Check the customer name and quantity.' })
        // Slow enough that a double click lands before the first save returns (planted: double-submit).
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
        const order: Order = {
          id: randomUUID(),
          customer: String(body.customer).slice(0, 200),
          quantity: Number(body.quantity),
          delivery: String(body.delivery),
          notes: String(body.notes ?? ''),
          createdBy: user,
        }
        orders.push(order)
        log('order-created', user, { id: order.id, customer: order.customer })
        return json(201, order)
      }
      const deleteMatch = /^\/api\/orders\/([0-9a-f-]{36})$/.exec(url.pathname)
      if (deleteMatch && req.method === 'DELETE') {
        orders = orders.filter((o) => o.id !== deleteMatch[1])
        log('order-deleted', user, { id: deleteMatch[1] })
        return json(200, { ok: true })
      }
      const photoMatch = /^\/api\/orders\/([0-9a-f-]{36})\/photo$/.exec(url.pathname)
      if (photoMatch && req.method === 'POST') {
        const body = await readBody(req)
        const png = body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        const jpeg = body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        if (!png && !jpeg) return json(400, { message: 'That file is not a PNG or JPEG photo.' })
        log('photo-uploaded', user, { order: photoMatch[1], bytes: body.length })
        return json(200, { kb: Math.round(body.length / 1024) })
      }
      if (url.pathname === '/api/spot' && req.method === 'POST') {
        const { x, y, order } = JSON.parse((await readBody(req)).toString() || '{}')
        const distance = Math.hypot(Number(x) - SPOT.x, Number(y) - SPOT.y)
        const hit = distance <= SPOT.radius + 4
        log('spot', user, { order, x, y, distance: Math.round(distance), hit })
        return json(200, { hit })
      }
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const { language } = JSON.parse((await readBody(req)).toString() || '{}')
        languages.set(user, String(language))
        log('setting-saved', user, { language })
        return json(200, { ok: true })
      }
      if (url.pathname === '/api/orders' && req.method === 'GET') return json(200, orders)
      return html(404, layout('Not found', '<h1>Page not found</h1>', user))
    } catch (error) {
      log('server-error', user, { route: url.pathname, reason: (error as Error).message })
      return json(500, { message: 'Something went wrong.' })
    }
  })

  // A port in use is an error to report, not an unhandled event that ends the process.
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    port,
    events: () => [...events],
    reset,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections()
        server.close(() => resolveClose())
      }),
  }
}
