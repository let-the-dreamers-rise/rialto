// The publisher's key, and where it lives.
//
// A feed is a contract plus somebody who keeps posting to it, and that somebody needs a key.
// Putting one in an environment variable means a person copies it there, which means it has
// passed through a screen. This does it the other way round: the key is generated here, on
// first use, and kept in Netlify Blobs — the site's own storage. It is never printed, never
// mailed, never pasted. The only thing that leaves is the address, at /api/publisher, which
// is what the oracle admin needs in order to authorise it and what anyone needs in order to
// send it gas.
//
// PUBLISHER_PK, if set, takes precedence, so a key held elsewhere can still be used.
import { getStore } from '@netlify/blobs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

export async function publisherAccount() {
  const env = Netlify.env.get('PUBLISHER_PK')
  if (env) return privateKeyToAccount(env)
  const store = getStore({ name: 'publisher', consistency: 'strong' })
  let pk = await store.get('key')
  if (!pk) {
    // Two first calls could race. Each writes, then re-reads, so both converge on whatever
    // the store holds; the address reported afterwards is the one that gets authorised.
    await store.set('key', generatePrivateKey())
    pk = await store.get('key')
  }
  return privateKeyToAccount(pk)
}

export default async () => {
  try {
    const { address } = await publisherAccount()
    return new Response(JSON.stringify({ address, source: Netlify.env.get('PUBLISHER_PK') ? 'env' : 'blobs' }),
      { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }),
      { status: 500, headers: { 'content-type': 'application/json' } })
  }
}
export const config = { path: '/api/publisher' }
