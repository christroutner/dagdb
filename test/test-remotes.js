/* globals it */
const Block = require('@ipld/block')
const inmem = require('../src/stores/inmemory')
const createUpdater = require('../src/updaters/kv')
const database = require('../src/database')(Block)
const createKV = require('./lib/mock-kv')
const test = it
const assert = require('assert')
const same = assert.deepStrictEqual
const ok = assert.ok

const create = async () => {
  const store = inmem()
  const updater = createUpdater(createKV())
  const db = await database.create(store, updater)
  return { store, db, updater }
}

const createRemotes = async (strategy) => {
  const dbs = await Promise.all([create(), create()])
  const [db1, db2] = dbs.map(db => db.db)
  const remote = await db1.remotes.addLocal('test', strategy)
  return { db1, db2, remote }
}

const v1 = 'db-v1'

test('nothing to merge', async () => {
  let { db1, db2, remote } = await createRemotes({ full: true })
  await remote.pullDatabase(db2)
  const latest = await db1.update()
  const kv1 = (await latest._kv).root
  const kv2 = (await db1._kv).root
  ok(kv1.equals(kv2))
  const root1 = await db1.store.get(db1.root)
  const root2 = await latest.store.get(latest.root)
  assert.ok(!root1.decode()[v1].remotes.equals(root2.decode()[v1].remotes))
  remote = await latest.remotes.get('test')
  const decoded = remote.rootDecode
  ok(decoded.head.equals(decoded.merged))
})

test('full merge', async () => {
  let { db1, db2, remote } = await createRemotes({ full: true })
  await db2.set('test', { hello: 'world' })
  db2 = await db2.commit()
  await remote.pullDatabase(db2)
  let latest = await db1.update()
  const kv1 = (await latest._kv).root
  const kv2 = (await db2._kv).root
  ok(kv1.equals(kv2))
  remote = await latest.remotes.get('test')
  await remote.pullDatabase(db2)
  latest = await latest.update()
  same(await latest.get('test'), { hello: 'world' })

  await db2.set('test', { foo: 'bar' })
  db2 = await db2.commit()
  remote = await latest.remotes.get('test')
  await remote.pullDatabase(db2)
  latest = await latest.update()
  same(await latest.get('test'), { foo: 'bar' })
})

test('keyed merge', async () => {
  let { db1, db2, remote } = await createRemotes({ keyed: 'test-db' })
  await db2.set('test', { hello: 'world' })
  db2 = await db2.commit()
  await remote.pullDatabase(db2)
  db1 = await db1.update()
  const kv1 = (await db2._kv).root
  const latestDB = await db1.get('test-db')
  const kv2 = (await latestDB._kv).root
  ok(kv1.equals(kv2))
  same(await latestDB.get('test'), { hello: 'world' })
  remote = await db1.remotes.get('test')
  await remote.pullDatabase(db2)

  let dbValue = await db1.get('test-db')
  same(await dbValue.get('test'), { hello: 'world' })

  await db2.set('test', { foo: 'bar' })
  db2 = await db2.commit()
  remote = await db1.remotes.get('test')
  await remote.pullDatabase(db2)
  db1 = await db1.commit()
  dbValue = await db1.get('test-db')
  same(await dbValue.get('test'), { foo: 'bar' })
})

if (!process.browser) {
  const stores = {}
  const updaters = {}

  const httpTests = require('./lib/http.js')
  const createHandler = require('../src/http/nodejs')

  const handler = async (req, res) => {
    const [id] = req.url.split('/').filter(x => x)
    const store = stores[id]
    const updater = updaters[id]
    if (!store) throw new Error('Missing store')
    const _handler = createHandler(Block, store, updater)
    return _handler(req, res, '/' + id)
  }
  httpTests(handler, port => {
    const createDatabase = require('../')
    const create = async (opts) => {
      const id = Math.random().toString()
      const url = `http://localhost:${port}/${id}`
      stores[id] = inmem()
      updaters[id] = createUpdater(createKV())
      return createDatabase.create(url)
    }
    test('basic full merge', async () => {
      let db1 = await create()
      let db2 = await create()
      await db2.set('test', { hello: 'world' })
      db2 = await db2.update()
      const info = { source: db2.updater.infoUrl, strategy: { full: true } }
      await db1.remotes.add('a', info)
      db1 = await db1.update()
      db1 = await createDatabase.open(db1.updater.infoUrl)
      same(await db1.get('test'), { hello: 'world' })
      await db2.set('test2', { foo: 'bar' })
      db2 = await db2.update()
      await db1.remotes.pull('a')
      same(await db1.get('test2'), { foo: 'bar' })
    })
  })
}
