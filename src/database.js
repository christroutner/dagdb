const { fromBlock, validate, readonly } = require('./utils')
const createKV = require('./kv')
const createStores = require('./stores')
const createUpdaters = require('./updaters')
const hamt = require('./hamt')
const replicate = require('./stores/replicate')
const CID = require('cids')
const bent = require('bent')
const getJSON = bent('json')

const databaseEncoder = async function * (db) {
  const kv = await db._kv
  if (kv.pending) throw new Error('Cannot use database with pending transactions as a value')
  // TODO: refactor to support encoding dirty databases
  // if you look at how .commit() is implemented in kv, it's
  // implemented as a generator and then flattened for the
  // .commit() method. that approach should be used here as well,
  // with all the commit() and latest() implementations below done as
  // generators that can be used by this encoder so that you can
  // use databases with pending transactions as values.
  yield db.root
}

module.exports = (Block) => {
  const toBlock = (value, className) => Block.encoder(validate(value, className), 'dag-cbor')
  const kv = createKV(Block)
  const stores = createStores(Block)
  const updaters = createUpdaters(Block)

  class Remote {
    constructor (obj, db) {
      this.db = db
      this.rootDecode = obj
      this.kv = db._kv
    }

    get info () {
      if (!this._info) {
        this._info = this.db.store.get(this.rootDecode.info).then(block => block.decodeUnsafe())
      }
      return this._info
    }

    async setStorage (info, resp) {
      let url = new URL(resp.blockstore, info.source)
      this.store = await stores.from(url.toString())
      if (resp.updater) {
        url = new URL(resp.updater, info.source)
        this.updater = await updaters.from(info.source, url.toString())
      }
    }

    async push () {
      const info = await this.info
      if (info.source === 'local') {
        throw new Error('Local remotes cannot push')
      }
      if (!info.strategy.full) {
        throw new Error('Can only push databases using full merge strategy')
      }
      const local = this.rootDecode.head
      const resp = await getJSON(info.source)
      if (!resp.updater) throw new Error('Remote must have updater to use push')
      const root = new CID(resp.root)

      await this.setStorage(info, resp)

      const db = new Database(root, this.store)
      const head = await db.getHead()
      if (!head.equals(local)) {
        throw new Error('Remote has updated since last pull, re-pull before pushing')
      }
      await replicate(this.db.root, this.db.store, this.store)
      const cid = await this.updater.update(this.db.root, root)
      if (!cid.equals(this.db.root)) {
        throw new Error('Remote has updated since last pull, re-pull before pushing')
      }
    }

    async pull () {
      const info = await this.info
      if (info.source === 'local') {
        throw new Error('Local remotes must use pullDatabase directly')
      }
      const resp = await getJSON(info.source)
      // TODO: validate response data against a schema
      const root = new CID(resp.root)
      await this.setStorage(info, resp)
      const database = new Database(root, this.store, this.updater)
      if (this.rootDecode.head) {
        if (this.rootDecode.head.equals(await database.getHead())) {
          return root // no changes since last merge
        }
      }
      return this.pullDatabase(database, info.strategy)
    }

    async pullDatabase (database) {
      const info = await this.info
      const strategy = info.strategy
      const known = []
      if (this.rootDecode.head) {
        known.push(this.rootDecode.head)
        known.push(this.rootDecode.merged)
      }
      let cids
      // istanbul ignore else
      if (strategy.full) {
        cids = await this.fullMerge(database, known)
      } else if (strategy.keyed) {
        cids = await this.keyedMerge(database, strategy.keyed, known)
      } else {
        throw new Error(`Unknown strategy '${JSON.stringify(strategy)}'`)
      }
      for (const cid of cids) {
        await replicate(cid, database.store, this.db.store)
      }
    }

    async keyedMerge (db, key, known) {
      const kv = await this.kv
      if (!(await kv.has(key))) {
        await kv.set(key, db)
      } else {
        const prev = await kv.get(key)
        const prevHead = await prev.getHead()
        const dbHead = await db.getHead()
        if (prevHead.equals(dbHead)) return []
        await prev.pull(db, known)
        const latest = await prev.commit()
        await kv.set(key, latest)
      }
      const latest = await kv.commit()
      this.rootDecode.head = await db.getHead()
      this.rootDecode.merged = await latest.getHead()
      return [latest.root]
    }

    async fullMerge (db, known) {
      const kv = await this.kv
      await kv.pull(db, known)
      this.rootDecode.head = await db.getHead()
      this.rootDecode.merged = null
      return kv.pendingTransactions()
    }

    async update (latest) {
      if (this.rootDecode.merged === null) {
        const trans = await this.db.store.get(latest)
        const head = trans.decode()['kv-v1'].head
        this.rootDecode.merged = head
      }
      return toBlock(this.rootDecode, 'Remote')
    }
  }

  class Lazy {
    constructor (db) {
      const root = db.getRoot().then(root => root['db-v1'][this.prop])
      readonly(this, '_root', root)
      this.db = db
      this.pending = new Map()
      this.store = db.store
      this._get = db.store.get.bind(db.store)
    }
  }

  class Remotes extends Lazy {
    get prop () {
      return 'remotes'
    }

    async add (name, info) {
      const block = toBlock(info, 'RemoteInfo')
      await this.db.store.put(block)
      const remote = new Remote({ info: await block.cid() }, this.db)
      return this.pull(name, remote)
    }

    async addLocal (name, strategy) {
      const info = { strategy, source: 'local' }
      const block = toBlock(info, 'RemoteInfo')
      await this.db.store.put(block)
      const remote = new Remote({ info: await block.cid() }, this.db)
      this.pending.set(name, remote)
      return remote
    }

    async get (name) {
      if (this.pending.has(name)) return this.pending.get(name)
      const root = await this._root
      const cid = await hamt.get(root, name, this._get)
      if (!cid) throw new Error(`No remote named "${name}"`)
      const block = await this.db.store.get(cid)
      const decoded = fromBlock(block, 'Remote')
      return new Remote(decoded, this.db)
    }

    async pull (name, remote) {
      if (!remote) {
        remote = await this.get(name)
      }
      await remote.pull()
      this.pending.set(name, remote)
    }

    push (name, ...args) {
      return this.get(name).then(r => r.push(...args))
    }

    async update (latest) {
      if (!this.pending.size) return this._root
      const ops = []
      const promises = []
      for (const [key, remote] of this.pending.entries()) {
        // TODO: implement remote removal
        const block = await remote.update(latest)
        promises.push(this.db.store.put(block))
        ops.push({ set: { key, val: await block.cid() } })
      }
      let last
      const head = await this.db._kv.then(kv => kv.getHead())
      const get = this.db.store.get.bind(this.db.store)
      for await (const block of hamt.bulk(head, ops, get, Block)) {
        last = block
        promises.push(this.db.store.put(block))
      }
      await Promise.all(promises)
      return last.cid()
    }
  }

  class Indexes extends Lazy {
    get prop () {
      return 'indexes'
    }

    async update (latest) {
      // TODO: implement index update process
      return this._root
    }
  }

  class Database {
    constructor (root, store, updater) {
      readonly(this, 'root', root)
      this.store = store
      this.updater = updater
      readonly(this, '_kv', this.getRoot().then(r => kv(r['db-v1'].kv, store)))
      this.remotes = new Remotes(this)
      this.indexes = new Indexes(this)
    }

    get _dagdb () {
      return { v1: 'database' }
    }

    async commit () {
      let kv = await this._kv
      if (kv.pending) {
        kv = await kv.commit()
      }
      const root = await this.getRoot()
      root['db-v1'].kv = kv.root
      root['db-v1'].remotes = await this.remotes.update(kv.root)
      root['db-v1'].indexes = await this.indexes.update(kv.root)
      const block = toBlock(root, 'Database')
      await this.store.put(block)
      return new Database(await block.cid(), this.store, this.updater)
    }

    async getHead () {
      const kv = await this._kv
      return kv.getHead()
    }

    async pull (...args) {
      const kv = await this._kv
      return kv.pull(...args)
    }

    async get (...args) {
      const kv = await this._kv
      return kv.get(...args)
    }

    async set (...args) {
      const kv = await this._kv
      return kv.set(...args)
    }

    async link (...args) {
      const kv = await this._kv
      return kv.link(...args)
    }

    async getRoot () {
      if (!this._rootBlock) {
        readonly(this, '_rootBlock', this.store.get(this.root))
      }
      const block = await this._rootBlock
      return fromBlock(block, 'Database')
    }

    async info () {
      const kv = await this._kv
      return { size: await kv.size() }
    }

    async merge (db) {
      const kv = await this._kv
      await kv.pull(db)
    }

    encode () {
      return databaseEncoder(this)
    }

    async update (...args) {
      let latest = await this.commit()
      let prevRoot = this.root
      if (latest.root.equals(this.root)) {
        prevRoot = null
      }
      let current = await this.updater.update(latest.root, prevRoot)
      while (!latest.root.equals(current)) {
        await this.merge(new Database(current, this.store, this.updater))
        latest = await this.commit()
        current = await this.updater.update(latest.root, current, ...args)
      }
      return new Database(current, this.store, this.updater)
    }
  }

  const exports = (...args) => new Database(...args)

  // empty database
  const empty = (async () => {
    const [kvBlock, hamtBlock] = await Promise.all(kv.empties)
    const [kvCID, hamtCID] = await Promise.all([kvBlock.cid(), hamtBlock.cid()])
    return toBlock({ 'db-v1': { kv: kvCID, remotes: hamtCID, indexes: hamtCID } }, 'Database')
  })()
  exports.empties = [empty, ...kv.empties]
  exports.create = async (store, updater) => {
    const empties = await Promise.all(exports.empties)
    await Promise.all(empties.map(b => store.put(b)))
    const root = await empties[0].cid()
    await updater.update(root)
    return new Database(root, store, updater)
  }
  exports.Remote = Remote
  kv.register('database', exports)
  return exports
}
