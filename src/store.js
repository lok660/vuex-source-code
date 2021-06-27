import applyMixin from './mixin'
import devtoolPlugin from './plugins/devtool'
import ModuleCollection from './module/module-collection'
import { forEachValue, isObject, isPromise, assert, partial } from './util'

let Vue // bind on install

export class Store {
  constructor(options = {}) {
    // Auto install if it is not done yet and `window` has `Vue`.
    // To allow users to avoid auto-installation in some cases,
    // this code should be placed here. See #731
    if (!Vue && typeof window !== 'undefined' && window.Vue) {
      install(window.Vue)
    }

    if (__DEV__) {
      assert(Vue, `must call Vue.use(Vuex) before creating a store instance.`)
      assert(typeof Promise !== 'undefined', `vuex requires a Promise polyfill in this browser.`)
      assert(this instanceof Store, `store must be called with the new operator.`)
    }

    const {
      plugins = [],
      strict = false
    } = options

    // store internal state
    this._committing = false    // // 表示提交的状态，当通过mutations方法改变state时，该状态为true，state值改变完后，该状态变为false; 在严格模式下会监听state值的改变，当改变时，_committing为false时，会发出警告，即表明state值的改变不是经过mutations的
    this._actions = Object.create(null)    // 用于记录所有存在的actions方法名称（包括全局的和命名空间内的，且允许重复定义）      
    this._actionSubscribers = []    // 存放actions方法订阅的回调函数
    this._mutations = Object.create(null)   // 用于记录所有存在的的mutations方法名称（包括全局的和命名空间内的，且允许重复定义）
    this._wrappedGetters = Object.create(null)    // 收集所有模块包装后的的getters（包括全局的和命名空间内的，但不允许重复定义）
    /*根据Store传入的配置项，构建模块 module 树，整棵 module 树存放在 this.root 属性上：
      1、Vuex 支持 store 分模块传入，存储分析后的 modules；
      2、ModuleCollection 主要将实例 store 传入的 options 对象整个构造为一个 module 对象，
     并循环调用 this.register([key], rawModule, false) 为其中的 modules 属性进行模块注册，
     使其都成为 module 对象，最后 options 对象被构造成一个完整的组件树。
    */
    this._modules = new ModuleCollection(options)   // 根据传入的options配置，注册各个模块，此时只是注册、建立好了各个模块的关系，已经定义了各个模块的state状态，但getters、mutations等方法暂未注册
    this._modulesNamespaceMap = Object.create(null)   // 存储定义了命名空间的模块
    this._subscribers = []    // 存放mutations方法订阅的回调
    this._watcherVM = new Vue()   //  new Vue实例用于监听state、getters
    this._makeLocalGettersCache = Object.create(null)   // getters的本地缓存

    // bind commit and dispatch to self
    // 替换 this 中的 dispatch, commit 方法，将 this 指向 store
    const store = this
    const { dispatch, commit } = this
    this.dispatch = function boundDispatch (type, payload) {
      return dispatch.call(store, type, payload)
    }
    this.commit = function boundCommit (type, payload, options) {
      return commit.call(store, type, payload, options)
    }

    // strict mode
    this.strict = strict

    const state = this._modules.root.state

    // init root module.
    // this also recursively registers all sub-modules
    // and collects all module getters inside this._wrappedGetters
    //  加载安装模块
    installModule(this, state, [], this._modules.root)

    // initialize the store vm, which is responsible for the reactivity
    // (also registers _wrappedGetters as computed properties)
    //  重置虚拟 store,使其成为响应式
    resetStoreVM(this, state)

    // apply plugins
    plugins.forEach(plugin => plugin(this))

    const useDevtools = options.devtools !== undefined ? options.devtools : Vue.config.devtools
    if (useDevtools) {
      devtoolPlugin(this)
    }
  }
  // 获取 state, 是从虚拟 state 上获取的，为了区别，所以使用的是 $$state
  get state () {
    return this._vm._data.$$state
  }

  //  只能通过__withCommit修改state的状态
  set state (v) {
    if (__DEV__) {
      assert(false, `use store.replaceState() to explicit replace store state.`)
    }
  }

  /*统一commit传入参数：
    1、以载荷形式分发（默认提取为type、payload）
       store.commit('incrementAsync', { amount: 10 })
    2、以对象形式分发
       store.commit({ type: 'incrementAsync', amount: 10 })
  */
  commit (_type, _payload, _options) {
    // check object-style commit
    //  检验参数
    const {
      type,
      payload,
      options
    } = unifyObjectStyle(_type, _payload, _options)

    const mutation = { type, payload }
    //  取出type对应的mutation方法
    const entry = this._mutations[type]
    if (!entry) {
      //  不存在此mutation type,报错
      if (__DEV__) {
        console.error(`[vuex] unknown mutation type: ${type}`)
      }
      return
    }

    //  专用修改state方法，其他修改state方法均是非法修改
    this._withCommit(() => {
      entry.forEach(function commitIterator (handler) {
        handler(payload)
      })
    })

    // 订阅者函数遍历执行，传入当前的mutation对象和当前的state
    this._subscribers
      .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
      .forEach(sub => sub(mutation, this.state))

    if (
      __DEV__ &&
      options && options.silent
    ) {
      console.warn(
        `[vuex] mutation type: ${type}. Silent option has been removed. ` +
        'Use the filter functionality in the vue-devtools'
      )
    }
  }

  /*统一dispatch传入参数：
      1、以载荷形式分发（默认提取为type、payload）
        store.dispatch('incrementAsync', { amount: 10 })
      2、以对象形式分发
     store.dispatch({ type: 'incrementAsync', amount: 10 })
*/
  dispatch (_type, _payload) {
    // check object-style dispatch
    const {
      type,
      payload
    } = unifyObjectStyle(_type, _payload)   //  配置参数处理

    const action = { type, payload }
    const entry = this._actions[type]   //  当前type所有action处理函数集合
    if (!entry) {
      if (__DEV__) {
        console.error(`[vuex] unknown action type: ${type}`)
      }
      return
    }

    //  调用_actionSubscribers中所有的before方法
    try {
      this._actionSubscribers
        .slice() // shallow copy to prevent iterator invalidation if subscriber synchronously calls unsubscribe
        .filter(sub => sub.before)
        .forEach(sub => sub.before(action, this.state))
    } catch (e) {
      if (__DEV__) {
        console.warn(`[vuex] error in before action subscribers: `)
        console.error(e)
      }
    }

    const result = entry.length > 1
      ? Promise.all(entry.map(handler => handler(payload)))
      : entry[0](payload)

    //  返回Promise
    return new Promise((resolve, reject) => {
      result.then(res => {
        try {
          //  调用_actionSubscribers中所有的after方法
          this._actionSubscribers
            .filter(sub => sub.after)
            .forEach(sub => sub.after(action, this.state))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in after action subscribers: `)
            console.error(e)
          }
        }
        resolve(res)
      }, error => {
        try {
          this._actionSubscribers
            .filter(sub => sub.error)
            .forEach(sub => sub.error(action, this.state, error))
        } catch (e) {
          if (__DEV__) {
            console.warn(`[vuex] error in error action subscribers: `)
            console.error(e)
          }
        }
        reject(error)
      })
    })
  }

  //  在commit函数中执行的订阅函数
  subscribe (fn, options) {
    return genericSubscribe(fn, this._subscribers, options)
  }

  //  在 dispatch 函数中执行的订阅函数
  subscribeAction (fn, options) {
    const subs = typeof fn === 'function' ? { before: fn } : fn
    return genericSubscribe(subs, this._actionSubscribers, options)
  }

  //  提供监听 state 和 getter 变化的 watch
  watch (getter, cb, options) {
    if (__DEV__) {
      assert(typeof getter === 'function', `store.watch only accepts a function.`)
    }
    //  本质就是一个Vue实例,调用$watch方法
    return this._watcherVM.$watch(() => getter(this.state, this.getters), cb, options)
  }

  //  提供“时空穿梭”功能，即返回到指定的 state 状态
  replaceState (state) {
    this._withCommit(() => {
      this._vm._data.$$state = state
    })
  }

  registerModule (path, rawModule, options = {}) {
    if (typeof path === 'string') path = [path]   //  模块路径保证为数组

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
      assert(path.length > 0, 'cannot register the root module by using registerModule.')
    }
    /*根据Store传入的配置项，构建模块 module 树，整棵 module 树存放在 this.root 属性上：
      1、Vuex 支持 store 分模块传入，存储分析后的 modules；
      2、ModuleCollection 主要将实例 store 传入的 options 对象整个构造为一个 module 对象，
         并循环调用 this.register([key], rawModule, false) 为其中的 modules 属性进行模块注册，
         使其都成为 module 对象，最后 options 对象被构造成一个完整的组件树。
    */
    this._modules.register(path, rawModule)
    /*module 安装：
      1、存储命名空间 namespace 对应的 module 在 store 的 _modulesNamespaceMap 属性中
      2、设置当前 module 为响应式、
      3、设置当前 module 局部的 dispatch、commit 方法以及 getters 和 state
      4、将局部的 mutations 注册到全局 store 的 _mutations 属性下、
     将局部的 actions 注册到全局 store 的 _actions 属性下、
     将局部的 getters 注册到全局 store 的 _wrappedGetters 属性下、
     子 module 的安装
*/
    installModule(this, this.state, path, this._modules.get(path), options.preserveState)
    // reset store to update getters...
    resetStoreVM(this, this.state)
  }

  unregisterModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    //  根据当前传入 path，移除对应的 module 模块
    this._modules.unregister(path)
    this._withCommit(() => {
      //  根据当前传入 path 获取父模块 module 的 state
      const parentState = getNestedState(this.state, path.slice(0, -1))
      //  动态删除响应式数据：target、key
      Vue.delete(parentState, path[path.length - 1])
    })
    //  module 模块的重置：数据重置 + 重装module 树 + 重置 store 的 vue 的 实例
    resetStore(this)
  }

  hasModule (path) {
    if (typeof path === 'string') path = [path]

    if (__DEV__) {
      assert(Array.isArray(path), `module path must be a string or an Array.`)
    }

    return this._modules.isRegistered(path)
  }

  hotUpdate (newOptions) {
    //  1、更新命名空间、更新 actions、更新 mutations、更新 getters；
    //  2、递归调用更新
    this._modules.update(newOptions)
    resetStore(this, true)
  }

  _withCommit (fn) {
    //  调用withCommit修改state的值时会将store的committing值置为true,内部会有断言检查该值
    //  在严格模式下只允许使用mutation来修改store中的值，而不允许直接修改store的数值 */
    const committing = this._committing
    this._committing = true
    fn()
    this._committing = committing
  }
}

function genericSubscribe (fn, subs, options) {
  if (subs.indexOf(fn) < 0) {
    options && options.prepend
      ? subs.unshift(fn)
      : subs.push(fn)
  }
  return () => {
    const i = subs.indexOf(fn)
    if (i > -1) {
      subs.splice(i, 1)
    }
  }
}

//  重置Store
function resetStore (store, hot) {
  store._actions = Object.create(null)
  store._mutations = Object.create(null)
  store._wrappedGetters = Object.create(null)
  store._modulesNamespaceMap = Object.create(null)
  const state = store.state
  // init all modules
  installModule(store, state, [], store._modules.root, true)
  // reset vm
  resetStoreVM(store, state, hot)
}

function resetStoreVM (store, state, hot) {
  const oldVm = store._vm

  // bind store public getters
  store.getters = {}    // 在实例store上设置getters对象
  // reset local getters cache
  store._makeLocalGettersCache = Object.create(null)    //  清空本地缓存
  const wrappedGetters = store._wrappedGetters
  const computed = {}
  //  循环所有处理过的getters，并新建computed对象进行存储
  //  通过Object.defineProperty方法为getters对象建立属性，使得我们通过this.$store.getters.xxxgetter能够访问到该getters
  forEachValue(wrappedGetters, (fn, key) => {
    // use computed to leverage its lazy-caching mechanism
    // direct inline function use will lead to closure preserving oldVm.
    // using partial to return function with only arguments preserved in closure environment.
    computed[key] = partial(fn, store)
    Object.defineProperty(store.getters, key, {
      get: () => store._vm[key],
      enumerable: true // for local getters
    })
  })
  // use a Vue instance to store the state tree
  // suppress warnings just in case the user has added
  // some funky global mixins
  const silent = Vue.config.silent
  Vue.config.silent = true
  //    设置新的storeVm，将当前初始化的state以及getters作为computed属性
  store._vm = new Vue({
    data: {
      $$state: state
    },
    computed
  })
  Vue.config.silent = silent

  // enable strict mode for new vm
  if (store.strict) {
    enableStrictMode(store)
  }

  // 若不是初始化过程执行的该方法，将旧的组件state设置为null，
  if (oldVm) {
    if (hot) {
      // dispatch changes in all subscribed watchers
      // to force getter re-evaluation for hot reloading.
      // 解除对旧的vm对state的引用
      store._withCommit(() => {
        oldVm._data.$$state = null
      })
    }
    //  强制更新所有监听者(watchers)，待更新生效，DOM更新完成后，执行vm组件的destroy方法进行销毁，减少内存的占用
    Vue.nextTick(() => oldVm.$destroy())
  }
}

//  注册mutation、action以及getter，同时递归安装所有子module
function installModule (store, rootState, path, module, hot) {
  const isRoot = !path.length
  //  根据当前传入 path，获取对应的 module 模块的命名空间
  const namespace = store._modules.getNamespace(path)

  // register in namespace map
  // 存储命名空间 namespace 对应的 module 在 store 的 _modulesNamespaceMap 属性中
  if (module.namespaced) {
    if (store._modulesNamespaceMap[namespace] && __DEV__) {
      console.error(`[vuex] duplicate namespace ${namespace} for the namespaced module ${path.join('/')}`)
    }
    //  将命名空间 namespace 字符串路径存入 Store
    store._modulesNamespaceMap[namespace] = module
  }

  // set state
  if (!isRoot && !hot) {
    //  根据当前传入 path（除去最后一项，即自身；此时 path 最后一项为 当前 path 的父级），获取父模块
    const parentState = getNestedState(rootState, path.slice(0, -1))
    const moduleName = path[path.length - 1]
    store._withCommit(() => {
      if (__DEV__) {
        if (moduleName in parentState) {
          console.warn(
            `[vuex] state field "${moduleName}" was overridden by a module with the same name at "${path.join('.')}"`
          )
        }
      }
      Vue.set(parentState, moduleName, module.state)
    })
  }

  //  定义 local 变量和 module.context 的值：设置当前 module 局部的 dispatch、commit 方法以及 getters 和 state
  const local = module.context = makeLocalContext(store, namespace, path)

  // 注册对应模块的mutation，供state修改使用
  module.forEachMutation((mutation, key) => {
    const namespacedType = namespace + key
    registerMutation(store, namespacedType, mutation, local)
  })

  // 注册对应模块的action，供数据操作、提交mutation等异步操作使用
  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key
    const handler = action.handler || action
    registerAction(store, type, handler, local)
  })

  // 注册对应模块的getters，供state读取使用
  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key
    registerGetter(store, namespacedType, getter, local)
  })

  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot)
  })
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 */
//  为该module设置局部的 dispatch、commit方法以及getters和state
function makeLocalContext (store, namespace, path) {
  const noNamespace = namespace === ''

  const local = {
    dispatch: noNamespace ? store.dispatch : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._actions[type]) {
          console.error(`[vuex] unknown local action type: ${args.type}, global type: ${type}`)
          return
        }
      }

      return store.dispatch(type, payload)
    },

    commit: noNamespace ? store.commit : (_type, _payload, _options) => {
      const args = unifyObjectStyle(_type, _payload, _options)
      const { payload, options } = args
      let { type } = args

      if (!options || !options.root) {
        type = namespace + type
        if (__DEV__ && !store._mutations[type]) {
          console.error(`[vuex] unknown local mutation type: ${args.type}, global type: ${type}`)
          return
        }
      }

      store.commit(type, payload, options)
    }
  }

  // getters and state object must be gotten lazily
  // because they will be changed by vm update
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  })

  return local
}

function makeLocalGetters (store, namespace) {
  if (!store._makeLocalGettersCache[namespace]) {
    const gettersProxy = {}
    const splitPos = namespace.length
    Object.keys(store.getters).forEach(type => {
      // skip if the target getter is not match this namespace
      if (type.slice(0, splitPos) !== namespace) return

      // extract local getter type
      const localType = type.slice(splitPos)

      // Add a port to the getters proxy.
      // Define as getter property because
      // we do not want to evaluate the getters in this time.
      Object.defineProperty(gettersProxy, localType, {
        get: () => store.getters[type],
        enumerable: true
      })
    })
    store._makeLocalGettersCache[namespace] = gettersProxy
  }

  return store._makeLocalGettersCache[namespace]
}

function registerMutation (store, type, handler, local) {
  // 取出对应type的mutations-handler集合
  const entry = store._mutations[type] || (store._mutations[type] = [])
  // commit实际调用的不是我们传入的handler，而是经过封装的
  entry.push(function wrappedMutationHandler (payload) {
    // 调用handler并将state传入
    handler.call(store, local.state, payload)
  })
}

function registerAction (store, type, handler, local) {
  // 取出对应type的actions-handler集合
  const entry = store._actions[type] || (store._actions[type] = [])
  // 存储新的封装过的action-handler
  entry.push(function wrappedActionHandler (payload) {
    // 传入 state 等对象供我们原action-handler使用
    let res = handler.call(store, {
      dispatch: local.dispatch,
      commit: local.commit,
      getters: local.getters,
      state: local.state,
      rootGetters: store.getters,
      rootState: store.state
    }, payload)
    if (!isPromise(res)) {
      // action需要支持promise进行链式调用，这里进行兼容处理
      res = Promise.resolve(res)
    }
    if (store._devtoolHook) {
      return res.catch(err => {
        store._devtoolHook.emit('vuex:error', err)
        throw err
      })
    } else {
      /// 返回Promise
      return res
    }
  })
}

function registerGetter (store, type, rawGetter, local) {
  // getters只允许存在一个处理函数，若重复需要报错
  if (store._wrappedGetters[type]) {
    if (__DEV__) {
      console.error(`[vuex] duplicate getter key: ${type}`)
    }
    return
  }
  // 存储封装过的getters处理函数
  store._wrappedGetters[type] = function wrappedGetter (store) {
    // 为原getters传入对应状态
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    )
  }
}

//  严格模式
function enableStrictMode (store) {
  //  利用vm的$watch方法来观察$$state,在它被修改的时候进入回调
  store._vm.$watch(function () { return this._data.$$state }, () => {
    if (__DEV__) {
      //  当store._committing为false的时候会触发断言，抛出异常
      assert(store._committing, `do not mutate vuex store state outside mutation handlers.`)
    }
  }, { deep: true, sync: true })
}

function getNestedState (state, path) {
  return path.reduce((state, key) => state[key], state)
}

function unifyObjectStyle (type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload
    payload = type
    type = type.type
  }

  if (__DEV__) {
    assert(typeof type === 'string', `expects string as the type, but found ${typeof type}.`)
  }

  return { type, payload, options }
}

//  install  entry
export function install (_Vue) {
  if (Vue && _Vue === Vue) {
    if (__DEV__) {
      console.error(
        '[vuex] already installed. Vue.use(Vuex) should be called only once.'
      )
    }
    return
  }
  Vue = _Vue
  // install1.调用 applyMixin 方法来初始化 vuex
  applyMixin(Vue)
}
