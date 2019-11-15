import * as Logger from '../logger'

jest.mock('../logger')

describe('test global config', () => {
  describe('test environment', () => {
    jest.isolateModules(() => {
      const Config = require('../config')

      afterEach(() => {
        jest.clearAllMocks()
        Config.default.destroy()
      })

      afterAll(() => {
        jest.restoreAllMocks()
      })

      it('returns false for initialised state', () => {
        expect(Config.default.isInitialised()).toBeFalsy()
      })

      it('returns error when there are missing mandatory params', () => {

        jest.spyOn(Logger.default, 'error')

        Config.default.setBaseParams({})

        expect(Logger.default.error).toHaveBeenCalledWith('You must define appToken and environment')
        expect(Config.default.isInitialised()).toBeFalsy()
        expect(Config.default.getBaseParams()).toEqual({})

        Config.default.setBaseParams({appToken: 'bla'})

        expect(Logger.default.error).toHaveBeenCalledWith('You must define environment')
        expect(Config.default.isInitialised()).toBeFalsy()
        expect(Config.default.getBaseParams()).toEqual({})

      })

      it('returns true for correctly initialised state', () => {

        const appParams = {
          appToken: '123abc',
          environment: 'sandbox'
        }

        Config.default.setBaseParams(appParams)

        const baseParams = Config.default.getBaseParams()

        expect(Config.default.isInitialised()).toBeTruthy()
        expect(baseParams).toEqual(appParams)
        expect(baseParams).not.toBe(appParams)
      })

      it('overrides base and gdpr urls with custom one', () => {
        Config.default.setBaseParams({
          appToken: '123abc',
          environment: 'sandbox',
          customUrl: 'http://some-url.com'
        })

        expect(Config.default.isInitialised()).toBeTruthy()
        expect(Config.default.getCustomConfig()).toEqual({url: 'http://some-url.com'})
        expect(Config.default.getBaseParams()).toEqual({
          appToken: '123abc',
          environment: 'sandbox'
        })
      })

      it('checks if only copies returned', () => {
        Config.default.setBaseParams({
          appToken: '123abc',
          environment: 'sandbox',
          customUrl: 'http://some-url.com'
        })

        const baseParams1 = Config.default.getBaseParams()
        const baseParams2 = Config.default.getBaseParams()

        expect(baseParams1).toEqual(baseParams2)
        expect(baseParams1).not.toBe(baseParams2)
      })

      it('sets only allowed parameters', () => {
        Config.default.setBaseParams({
          appToken: '123abc',
          environment: 'sandbox',
          defaultTracker: 'tracker',
          customUrl: 'http://some-url.com',
          something: 'else'
        })

        expect(Config.default.isInitialised()).toBeTruthy()
        expect(Config.default.getCustomConfig()).toEqual({url: 'http://some-url.com'})
        expect(Config.default.getBaseParams()).toEqual({
          appToken: '123abc',
          environment: 'sandbox',
          defaultTracker: 'tracker'
        })
      })

      it('destroys config', () => {

        const appParams = {
          appToken: '123abc',
          environment: 'sandbox'
        }

        Config.default.setBaseParams(appParams)

        expect(Config.default.isInitialised()).toBeTruthy()
        expect(Config.default.getBaseParams()).toEqual(appParams)

        Config.default.destroy()

        expect(Config.default.isInitialised()).toBeFalsy()
        expect(Config.default.getBaseParams()).toEqual({})
      })
    })
  })

  describe('development environment', () => {
    jest.isolateModules(() => {
      global.process.env.NODE_ENV = 'development'
      const Config = require('../config')

      it('sets base urls for env other then test', () => {
        expect(Config.default.baseUrl).toEqual({
          app: 'https://app.adjust.com',
          gdpr: 'https://gdpr.adjust.com'
        })
      })
    })
  })

  describe('global constants not available', () => {
    const oldNamespace = global.__ADJUST__NAMESPACE
    const oldSdkVersion = global.__ADJUST__SDK_VERSION

    global.__ADJUST__NAMESPACE = undefined
    global.__ADJUST__SDK_VERSION = undefined

    afterAll(() => {
      global.__ADJUST__NAMESPACE = oldNamespace
      global.__ADJUST__SDK_VERSION = oldSdkVersion
    })

    jest.isolateModules(() => {
      const Config = require('../config')

      it('falls back to default values', () => {

        const appParams = {
          appToken: '123abc',
          environment: 'sandbox'
        }

        Config.default.setBaseParams(appParams)

        expect(Config.default.namespace).toEqual('adjust-sdk')
        expect(Config.default.version).toEqual('0.0.0')
      })
    })
  })

})
