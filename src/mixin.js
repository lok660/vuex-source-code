export default function (Vue) {
  const version = Number(Vue.version.split('.')[0])

  // install2.如果大版本号大于等于 2 ，那就表示 Vue 拥有了 mixin 方法
  // 这样我们就可以直接调用它，把 vuexInit 添加到 beforeCreate 钩子函数中
  if (version >= 2) {
    Vue.mixin({ beforeCreate: vuexInit })
  } else {
    // override init and inject vuex init procedure
    // for 1.x backwards compatibility.
    const _init = Vue.prototype._init
    Vue.prototype._init = function (options = {}) {
      options.init = options.init
        ? [vuexInit].concat(options.init)
        : vuexInit
      _init.call(this, options)
    }
  }

  /**
   * Vuex init hook, injected into each instances init hooks list.
   */

  //  install3.根组件从这里拿到 store，子组件从父组件拿到，这样一层一层传递下去，
  //  实现所有组件都有$store属性，这样我们就可以在任何组件中通过this.$store 访问到 store
  function vuexInit() {
    const options = this.$options
    // store injection
    //  根组件
    if (options.store) {
      this.$store = typeof options.store === 'function'
        ? options.store()
        : options.store
    } else if (options.parent && options.parent.$store) {
      // install4.如果当前参数没有 store 对象，但是有 parent 对象，那就说明它依赖于其父组件
      // 那么将它的父组件的 store 挂载在 this.$store 上
      this.$store = options.parent.$store
    }
  }
}
