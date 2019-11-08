import Config from '../config'
import SchemeMap from './scheme-map'
import ActivityState from '../activity-state'
import State from '../state'
import QuickStorage from '../storage/quick-storage'
import Logger from '../logger'
import {isEmpty, isObject, entries} from '../utilities'
import {convertRecord, convertStoreName} from './converter'

const _dbName = Config.namespace
const _dbVersion = 1
let _db

/**
 * Check if IndexedDB is supported in the current browser (exclude iOS forcefully)
 *
 * @returns {boolean}
 */
function isSupported () {
  const indexedDB = _getIDB()
  const iOS = !!navigator.platform && /iPad|iPhone|iPod/.test(navigator.platform)
  const supported = !!indexedDB && !iOS

  if (!supported) {
    Logger.error('IndexedDB is not supported in this browser')
  }

  return supported
}

/**
 * Get indexedDB instance
 *
 * @returns {IDBFactory}
 * @private
 */
function _getIDB () {
  return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB
}

/**
 * Handle database upgrade/initialization
 * - store activity state from memory if database unexpectedly got lost in the middle of the window session
 * - migrate data from localStorage if available on browser upgrade
 *
 * @param {Object} e
 * @param {Function} reject
 * @private
 */
function _handleUpgradeNeeded (e, reject) {

  const db = e.target.result

  e.target.transaction.onerror = reject
  e.target.transaction.onabort = reject

  const storeNames = SchemeMap.storeNames.left
  const activityState = ActivityState.current || {}
  const inMemoryAvailable = activityState && !isEmpty(activityState)

  entries(storeNames)
    .filter(([, store]) => !store.permanent)
    .forEach(([longStoreName, store]) => {
      const options = SchemeMap.right[longStoreName]
      const objectStore = db.createObjectStore(store.name, {
        keyPath: options.keyPath,
        autoIncrement: options.autoIncrement || false
      })

      if (options.index) {
        objectStore.createIndex(`${options.index}Index`, options.index)
      }

      if (store.name === storeNames.activityState.name && inMemoryAvailable) {
        objectStore.add(convertRecord({
          storeName: longStoreName,
          record: activityState,
          dir: 'left'
        }))
        Logger.info('Activity state has been recovered')
      } else if (QuickStorage.stores[store.name]) {
        QuickStorage.stores[store.name].forEach(record => objectStore.add(record))
        Logger.info(`Migration from localStorage done for ${longStoreName} store`)
      }
    })

  State.recover()
  QuickStorage.clear()
}

/**
 * Handle successful database opening
 *
 * @param {Object} e
 * @param {Function} resolve
 * @private
 */
function _handleOpenSuccess (e, resolve) {

  _db = e.target.result

  resolve({success: true})

  _db.onclose = destroy
}

/**
 * Open the database connection and create store if not existent
 *
 * @returns {Promise}
 * @private
 */
function _open () {

  const indexedDB = _getIDB()

  if (!isSupported()) {
    return Promise.reject({name: 'IDBNotSupported', message: 'IndexedDB is not supported'})
  }

  return new Promise((resolve, reject) => {

    if (_db) {
      resolve({success: true})
      return
    }

    const request = indexedDB.open(_dbName, _dbVersion)

    request.onupgradeneeded = e => _handleUpgradeNeeded(e, reject)
    request.onsuccess = e => _handleOpenSuccess(e, resolve)
    request.onerror = reject
  })
}

/**
 * Get transaction and the store
 *
 * @param {string} storeName
 * @param {string} mode
 * @param {Function} reject
 * @returns {{transaction, store: IDBObjectStore, index: IDBIndex}}
 * @private
 */
function _getTranStore ({storeName, mode}, reject) {

  const transaction = _db.transaction([storeName], mode)
  const store = transaction.objectStore(storeName)
  const options = SchemeMap.right[convertStoreName({storeName, dir: 'right'})]
  let index

  if (options.index) {
    index = store.index(`${options.index}Index`)
  }

  transaction.onerror = reject
  transaction.onabort = reject

  return {transaction, store, index, options}
}

/**
 * Override the error by extracting only name and message of the error
 *
 * @param {Function} reject
 * @param {Object} error
 * @returns {Object}
 * @private
 */
function _overrideError (reject, error) {
  const {name, message} = error.target.error
  return reject({name, message})
}

/**
 * Get list of composite keys if available
 * @param options
 * @returns {Array|null}
 * @private
 */
function _getCompositeKeys (options) {
  return options.fields[options.keyPath].composite || null
}

/**
 * Prepare the target to be queried depending on the composite key if defined
 *
 * @param {Object} options
 * @param {*} target
 * @param {string} action
 * @returns {*}
 * @private
 */
function _prepareTarget (options, target, action) {
  const addOrPut = ['add', 'put'].indexOf(action) !== -1
  const composite = _getCompositeKeys(options)

  return composite
    ? addOrPut
      ? {[options.keyPath]: composite.map(key => target[key]).join(''), ...target}
      : target ? target.join('') : null
    : target
}

/**
 * Prepare the result to be return depending on the composite key definition
 *
 * @param {Object} options
 * @param {Object} target
 * @returns {Array|null}
 * @private
 */
function _prepareResult (options, target) {
  const composite = _getCompositeKeys(options)
  return composite && isObject(target)
    ? composite.map(key => target[key])
    : null
}

/**
 * Initiate the database request
 *
 * @param {string} storeName
 * @param {*=} target
 * @param {string} action
 * @param {string} [mode=readonly]
 * @returns {Promise}
 * @private
 */
function _initRequest ({storeName, target = null, action, mode = 'readonly'}) {
  return _open()
    .then(() => {
      return new Promise((resolve, reject) => {
        const {store, options} = _getTranStore({storeName, mode}, reject)
        const request = store[action](_prepareTarget(options, target, action))
        const result = _prepareResult(options, target)

        request.onsuccess = () => {
          if (action === 'get' && !request.result) {
            reject({name: 'NotRecordFoundError', message: `Requested record not found in "${storeName}" store`})
          } else {
            resolve(result || request.result || target)
          }
        }

        request.onerror = error => _overrideError(reject, error)
      })
    })
}

/**
 * Initiate bulk database request by reusing the same transaction to perform the operation
 *
 * @param {string} storeName
 * @param {Array} target
 * @param {string} action
 * @param {string} mode
 * @returns {Promise}
 * @private
 */
function _initBulkRequest ({storeName, target, action, mode}) {
  return _open()
    .then(() => {
      return new Promise((resolve, reject) => {
        if (!target || target && !target.length) {
          return reject({name: 'NoTargetDefined', message: `No array provided to perform ${action} bulk operation into "${storeName}" store`})
        }

        const {transaction, store, options} = _getTranStore({storeName, mode}, reject)
        let result = []
        let current = target[0]

        transaction.oncomplete = () => resolve(result)

        request(store[action](_prepareTarget(options, current, action)))

        function request (req) {
          req.onerror = error => _overrideError(reject, error)
          req.onsuccess = () => {
            result.push(_prepareResult(options, current) || req.result)

            current = target[result.length]

            if (result.length < target.length) {
              request(store[action](_prepareTarget(options, current, action)))
            }
          }
        }
      })
    })
}

/**
 * Open cursor for bulk operations or listing
 *
 * @param {string} storeName
 * @param {string} action
 * @param {IDBKeyRange=} range
 * @param {boolean=} firstOnly
 * @param {string} [mode=readonly]
 * @returns {Promise}
 * @private
 */
function _openCursor ({storeName, action = 'list', range = null, firstOnly, mode = 'readonly'}) {
  return _open()
    .then(() => {
      return new Promise((resolve, reject) => {
        const {transaction, store, index, options} = _getTranStore({storeName, mode}, reject)
        const cursorRequest = (index || store).openCursor(range)
        const items = []

        transaction.oncomplete = () => resolve(firstOnly ? items[0] : items)

        cursorRequest.onsuccess = e => {

          const cursor = e.target.result

          if (cursor) {
            if (action === 'delete') {
              cursor.delete()
              items.push(_prepareResult(options, cursor.value) || cursor.value[options.keyPath])
            } else {
              items.push(cursor.value)
            }

            if (!firstOnly) {
              cursor.continue()
            }
          }
        }

        cursorRequest.onerror = reject
      })
    })
}

/**
 * Get all records from particular store
 *
 * @param {string} storeName
 * @param {boolean=} firstOnly
 * @returns {Promise}
 */

function getAll (storeName, firstOnly) {
  return _openCursor({storeName, firstOnly})
}

/**
 * Get the first row from the store
 *
 * @param {string} storeName
 * @returns {Promise}
 */
function getFirst (storeName) {
  return getAll(storeName, true)
}

/**
 * Get item from a particular store
 *
 * @param {string} storeName
 * @param {*} target
 * @returns {Promise}
 */
function getItem (storeName, target) {
  return _initRequest({storeName, target, action: 'get'})
}

/**
 * Return filtered result by value on available index
 *
 * @param {string} storeName
 * @param {string} by
 * @returns {Promise}
 */
function filterBy (storeName, by) {

  const range = IDBKeyRange.only(by)

  return _openCursor({storeName, range})
}

/**
 * Add item to a particular store
 *
 * @param {string} storeName
 * @param {Object} target
 * @returns {Promise}
 */
function addItem (storeName, target) {
  return _initRequest({storeName, target, action: 'add', mode: 'readwrite'})
}

/**
 * Add multiple items into particular store
 *
 * @param {string} storeName
 * @param {Array} target
 * @param {boolean=} overwrite
 * @returns {Promise}
 */
function addBulk (storeName, target, overwrite) {
  return _initBulkRequest({storeName, target, action: (overwrite ? 'put' : 'add'), mode: 'readwrite'})
}

/**
 * Update item in a particular store
 *
 * @param {string} storeName
 * @param {Object} target
 * @returns {Promise}
 */
function updateItem (storeName, target) {
  return _initRequest({storeName, target, action: 'put', mode: 'readwrite'})
}

/**
 * Delete item from a particular store
 *
 * @param {string} storeName
 * @param {*} target
 * @returns {Promise}
 */
function deleteItem (storeName, target) {
  return _initRequest({storeName, target, action: 'delete', mode: 'readwrite'})
}

/**
 * Delete items until certain bound (primary key as a bound scope)
 *
 * @param {string} storeName
 * @param {string|Object} condition
 * @param {*=} condition.upperBound
 * @returns {Promise}
 */
function deleteBulk (storeName, condition) {

  const range = isObject(condition)
    ? IDBKeyRange.upperBound(condition.upperBound)
    : IDBKeyRange.only(condition)

  return _openCursor({storeName, action: 'delete', range, mode: 'readwrite'})
}

/**
 * Clear all records from a particular store
 *
 * @param {string} storeName
 * @returns {Promise}
 */
function clear (storeName) {
  return _initRequest({storeName, action: 'clear', mode: 'readwrite'})
}

/**
 * Close the database and destroy the reference to it
 */
function destroy () {
  if (_db) {
    _db.close()
  }
  _db = null
}

export {
  isSupported,
  getAll,
  getFirst,
  getItem,
  filterBy,
  addItem,
  addBulk,
  updateItem,
  deleteItem,
  deleteBulk,
  clear,
  destroy
}

