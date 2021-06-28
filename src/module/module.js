import { forEachValue } from '../util'

// Base data struct for store's module, package with some attribute and method
//  实例当前模块：传入实例store传入的options对象
export default class Module {
  constructor(rawModule, runtime) {
    this.runtime = runtime
    // Store some children item
    this._children = Object.create(null)
    // Store the origin module object which passed by programmer
    this._rawModule = rawModule
    const rawState = rawModule.state

    // Store the origin module's state
    this.state = (typeof rawState === 'function' ? rawState() : rawState) || {}
  }
  //  判断该模块是否定义了namespaced，定义了则返回true; 否则返回false
  get namespaced() {
    return !!this._rawModule.namespaced
  }

  //  存储当前模块的子模块
  addChild(key, module) {
    this._children[key] = module
  }

  //  移除当前模块的子模块
  removeChild(key) {
    delete this._children[key]
  }

  //  获取当前模块指定的子模块
  getChild(key) {
    return this._children[key]
  }

  //  当前模块是否存在该子模块
  hasChild(key) {
    return key in this._children
  }

  //  更新当前模块：命名空间、actions、mutations、getters
  update(rawModule) {
    this._rawModule.namespaced = rawModule.namespaced
    if (rawModule.actions) {
      this._rawModule.actions = rawModule.actions
    }
    if (rawModule.mutations) {
      this._rawModule.mutations = rawModule.mutations
    }
    if (rawModule.getters) {
      this._rawModule.getters = rawModule.getters
    }
  }

  //  循环执行当前模块 子模块
  forEachChild(fn) {
    forEachValue(this._children, fn)
  }

  //  循环执行当前模块 getters
  forEachGetter(fn) {
    if (this._rawModule.getters) {
      forEachValue(this._rawModule.getters, fn)
    }
  }

  //  循环执行当前模块 actions
  forEachAction(fn) {
    if (this._rawModule.actions) {
      forEachValue(this._rawModule.actions, fn)
    }
  }

  //  循环执行当前模块 mutations
  forEachMutation(fn) {
    if (this._rawModule.mutations) {
      forEachValue(this._rawModule.mutations, fn)
    }
  }
}
