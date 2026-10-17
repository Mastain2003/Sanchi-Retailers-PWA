// Secrets: WA_TOKEN, WA_PHONE_ID, VERIFY_TOKEN, CATALOG_ID, ADMIN_PASSWORD, JWT_SECRET
const H={'content-type':'application/json','access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS'};
const J=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:H});
const enc=new TextEncoder();
const l10=p=>String(p).replace(/\D/g,'').slice(-10);
const norm=p=>{p=String(p).replace(/\D/g,'');return p.length===10?'91'+p:p};
async function sign(s,k){const key=await crypto.subtle.importKey('raw',enc.encode(k),{name:'HMAC',hash:'SHA-256'},false,['sign']);return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(s)))))}
async function mkToken(env){const p=btoa(JSON.stringify({exp:Date.now()+7*864e5}));return p+'.'+await sign(p,env.JWT_SECRET)}
async function okToken(t,env){try{const[p,s]=t.split('.');return s===await sign(p,env.JWT_SECRET)&&JSON.parse(atob(p)).exp>Date.now()}catch{return false}}
const today=()=>new Date(Date.now()+19800000).toISOString().slice(0,10);

async function webhook(req,env){
  const b=await req.json();
  for(const e of b.entry||[])for(const c of e.changes||[])for(const m of c.value?.messages||[]){
    if(m.type!=='order')continue;
    const r=await env.DB.prepare('SELECT retailer_id FROM retailer_phones WHERE substr(phone,-10)=?').bind(l10(m.from)).first();
    const o=await env.DB.prepare('INSERT OR IGNORE INTO orders(retailer_id,phone,wa_msg_id) VALUES(?,?,?)').bind(r?.retailer_id??null,m.from,m.id).run();
    if(!o.meta.changes)continue;
    const id=o.meta.last_row_id,st=[];
    for(const i of m.order.product_items){
      const p=await env.DB.prepare('SELECT name,rate FROM products WHERE id=?').bind(i.product_retailer_id).first();
      st.push(env.DB.prepare('INSERT INTO order_items(order_id,product_id,name,qty,rate) VALUES(?,?,?,?,?)').bind(id,i.product_retailer_id,p?.name||i.product_retailer_id,Number(i.quantity)||0,p?.rate??(Number(i.item_price)||0)));
    }
    if(st.length)await env.DB.batch(st);
  }
  return new Response('ok');
}

const num=v=>parseFloat(String(v??'').replace(/[^\d.]/g,''))||0;
async function sync(env){
  const f='retailer_id,name,description,price,sale_price,brand,category,availability,image_url,url,currency,item_group_id,size,color,material,pattern,gender,age_group';
  let url=`https://graph.facebook.com/v21.0/${env.CATALOG_ID}/products?fields=${f}&limit=100&access_token=${env.WA_TOKEN}`,n=0;const d0=today();
  while(url){
    const d=await(await fetch(url)).json();
    if(d.error)throw new Error(d.error.message);
    const st=[];
    for(const p of d.data||[]){
      const vr=[p.size,p.color,p.material,p.pattern,p.gender,p.age_group].filter(Boolean).join(' / ');const mrp=num(p.price),sale=num(p.sale_price),rate=sale>0?sale:mrp; // discount price is used for orders
      st.push(env.DB.prepare('INSERT INTO products(id,name,description,brand,category,availability,image_url,url,currency,item_group_id,variant,price,sale_price,rate,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,brand=excluded.brand,category=excluded.category,availability=excluded.availability,image_url=excluded.image_url,url=excluded.url,currency=excluded.currency,item_group_id=excluded.item_group_id,variant=excluded.variant,price=excluded.price,sale_price=excluded.sale_price,rate=excluded.rate,updated_at=excluded.updated_at').bind(p.retailer_id,p.name||'',p.description||'',p.brand||'',p.category||'',p.availability||'',p.image_url||'',p.url||'',p.currency||'',p.item_group_id||'',vr,mrp,sale,rate,d0),
              env.DB.prepare('INSERT INTO rate_history(product_id,rate,date) VALUES(?,?,?)').bind(p.retailer_id,rate,d0));
    }
    if(st.length)await env.DB.batch(st);
    n+=(d.data||[]).length;url=d.paging?.next||null;
  }
  return n;
}

async function deliver(id,env,body){
  const o=await env.DB.prepare('SELECT o.*,r.name rn FROM orders o LEFT JOIN retailers r ON r.id=o.retailer_id WHERE o.id=?').bind(id).first();
  if(!o)return J({error:'Order not found'},404);
  if(o.status!=='pending')return J({error:'Order already closed'},400);
  if(!o.retailer_id)return J({error:'Assign a retailer first'},400);
  const it=(await env.DB.prepare('SELECT id,qty,rate FROM order_items WHERE order_id=?').bind(id).all()).results;
  const want=new Map((body.items||[]).map(i=>[Number(i.id),Number(i.qty)]));
  let q=0,a=0,full=true;const up=[];
  for(const i of it){
    let d=want.has(i.id)?want.get(i.id):i.qty;if(!(d>=0))d=0;d=Math.min(d,i.qty);
    if(d<i.qty)full=false;q+=d;a+=d*i.rate;
    up.push(env.DB.prepare('UPDATE order_items SET delivered_qty=? WHERE id=?').bind(d,i.id));
  }
  if(q<=0)return J({error:'Enter at least one delivered quantity'},400);
  const date=today().split('-').reverse().join('-'),amt=a.toFixed(2);
  const url=`https://graph.facebook.com/v21.0/${env.WA_PHONE_ID}/messages`;
  const send=p=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+env.WA_TOKEN,'content-type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:o.phone,...p})});
  // Free text inside the 24h window, approved template otherwise
  const inWindow=Date.now()-new Date(o.created_at.replace(' ','T')+'Z')<23.5*3600*1000;
  let res=null;
  if(inWindow)res=await send({type:'text',text:{body:`Hello ${o.rn}, your order has been ${full?'delivered':'partially delivered'} on ${date}.\nTotal items: ${q}\nTotal amount: ₹${amt}\nThank you! – Sanchi`}});
  if(!res||!res.ok)res=await send({type:'template',template:{name:'order_delivered',language:{code:'en'},components:[{type:'body',parameters:[o.rn,date,String(q),amt].map(text=>({type:'text',text}))}]}});
  if(!res.ok)return J({error:'WhatsApp: '+await res.text()},502);
  up.push(env.DB.prepare("UPDATE orders SET status=?,delivered_at=CURRENT_TIMESTAMP WHERE id=?").bind(full?'delivered':'partial',id));
  await env.DB.batch(up);
  return J({ok:true,status:full?'delivered':'partial'});
}

async function savePhones(env,rid,phones){
  await env.DB.prepare('DELETE FROM retailer_phones WHERE retailer_id=?').bind(rid).run();
  const st=[...new Set((phones||[]).map(norm).filter(p=>p.length>=10))].map(p=>env.DB.prepare('INSERT OR REPLACE INTO retailer_phones(retailer_id,phone) VALUES(?,?)').bind(rid,p));
  if(st.length)await env.DB.batch(st);
  // re-link unassigned orders from these numbers
  for(const p of phones||[])await env.DB.prepare('UPDATE orders SET retailer_id=? WHERE retailer_id IS NULL AND substr(phone,-10)=?').bind(rid,l10(p)).run();
}

async function api(req,env,path){
  const m=req.method,D=env.DB;let x;
  if(path==='/login'&&m==='POST'){const b=await req.json();return b.password===env.ADMIN_PASSWORD?J({token:await mkToken(env)}):J({error:'Wrong password'},401)}
  if(!await okToken((req.headers.get('authorization')||'').slice(7),env))return J({error:'Unauthorized'},401);
  if(path==='/orders'&&m==='GET'){
    const q=new URL(req.url).searchParams,wh=[],bd=[],s=q.get('status')||'all';
    if(s==='pending')wh.push("o.status='pending'");else if(s==='done')wh.push("o.status!='pending'");
    const dd="date(o.created_at,'+330 minutes','+1 day')"; // delivery date = order date + 1 day
    if(q.get('from')){wh.push(dd+'>=?');bd.push(q.get('from'))}
    if(q.get('to')){wh.push(dd+'<=?');bd.push(q.get('to'))}
    if(q.get('retailer')){wh.push('o.retailer_id=?');bd.push(q.get('retailer'))}
    const r=await D.prepare(`SELECT o.id,o.status,o.created_at,o.delivered_at,o.phone,o.retailer_id,r.name rn,(SELECT json_group_array(json_object('id',oi.id,'pid',oi.product_id,'name',oi.name,'variant',COALESCE(p.variant,''),'qty',oi.qty,'dq',oi.delivered_qty,'rate',oi.rate)) FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=o.id) items FROM orders o LEFT JOIN retailers r ON r.id=o.retailer_id ${wh.length?'WHERE '+wh.join(' AND '):''} ORDER BY o.id DESC LIMIT 500`).bind(...bd).all();
    return J(r.results.map(o=>({...o,items:JSON.parse(o.items||'[]')})));
  }
  if(x=path.match(/^\/orders\/(\d+)$/)){return J((await D.prepare('SELECT name,qty,rate FROM order_items WHERE order_id=?').bind(x[1]).all()).results)}
  if(x=path.match(/^\/orders\/(\d+)\/assign$/)){const b=await req.json();await D.prepare('UPDATE orders SET retailer_id=? WHERE id=?').bind(b.retailer_id,x[1]).run();return J({ok:1})}
  if(x=path.match(/^\/orders\/(\d+)\/deliver$/))return deliver(x[1],env,await req.json().catch(()=>({})));
  if(path==='/retailers'&&m==='GET')return J((await D.prepare("SELECT r.*,(SELECT group_concat(phone,',') FROM retailer_phones WHERE retailer_id=r.id) phones FROM retailers r ORDER BY name").all()).results);
  if(path==='/retailers'&&m==='POST'){const b=await req.json();const r=await D.prepare('INSERT INTO retailers(name,address) VALUES(?,?)').bind(b.name,b.address||'').run();await savePhones(env,r.meta.last_row_id,b.phones);return J({ok:1})}
  if(x=path.match(/^\/retailers\/(\d+)$/)){
    if(m==='PUT'){const b=await req.json();await D.prepare('UPDATE retailers SET name=?,address=? WHERE id=?').bind(b.name,b.address||'',x[1]).run();await savePhones(env,x[1],b.phones);return J({ok:1})}
    if(m==='DELETE'){await D.prepare('DELETE FROM retailer_phones WHERE retailer_id=?').bind(x[1]).run();await D.prepare('DELETE FROM retailers WHERE id=?').bind(x[1]).run();return J({ok:1})}
  }
  if(path==='/products')return J((await D.prepare('SELECT * FROM products ORDER BY name').all()).results);
  if(path==='/sync'&&m==='POST')return J({synced:await sync(env)});
  return J({error:'Not found'},404);
}

export default{
  async fetch(req,env){
    if(req.method==='OPTIONS')return new Response(null,{headers:H});
    const u=new URL(req.url);
    try{
      if(u.pathname==='/webhook'){
        if(req.method==='GET')return u.searchParams.get('hub.verify_token')===env.VERIFY_TOKEN?new Response(u.searchParams.get('hub.challenge')):new Response('Forbidden',{status:403});
        return await webhook(req,env);
      }
      if(u.pathname.startsWith('/api/'))return await api(req,env,u.pathname.slice(4));
      return J({error:'Not found'},404);
    }catch(e){return J({error:e.message},500)}
  },
  async scheduled(_e,env,ctx){ctx.waitUntil(sync(env))}
};
