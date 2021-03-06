const tap = require('tap')
const { init } = require('./utils')

tap.test('basic init', async t => {
  const { run, dbfile, initOutput } = await init()
  tap.same(initOutput.stdout, `Initialized empty database in ${dbfile}\n`)
  const { stdout } = await run('info')
  console.log({ stdout })
})
