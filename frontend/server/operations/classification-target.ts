/** Pin the address used by pg before connecting; URI query overrides must not bypass test-only restore guards. */
export function classificationTarget(raw: string, restoreTest = false) {
 let url: URL
 try { url = new URL(raw) } catch { throw new Error('Invalid classification database target') }
 if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || (!url.pathname || url.pathname === '/') || url.hash) throw new Error('Invalid classification database target')
 const allowed = new Set(['sslmode', 'channel_binding', 'schema'])
 if ([...url.searchParams.keys()].some(key => !allowed.has(key))) throw new Error('Database routing query overrides are not supported')
 const schema = url.searchParams.get('schema') || 'public'
 if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('Invalid classification database schema')
 // An omitted URI port must not inherit an unrelated PGPORT from the shell.
 if (!url.port) url.port = '5432'
 if (restoreTest && (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/[a-z][a-z0-9_]{0,48}_test$/.test(url.pathname))) throw new Error('Restore requires a disposable local test database')
 return { connectionString: url.toString(), identity: { host: url.hostname.replace('-pooler', ''), port: url.port, database: url.pathname, schema } }
}
