import { Store, install } from './store'
import { mapState, mapMutations, mapGetters, mapActions, createNamespacedHelpers } from './helpers'
import createLogger from './plugins/logger'

// 从这里就可以看出，我们可以使用 vuex 的什么方法与属性，如最基本的 Store
// 供给 Vue.use() 全局挂载的 install
// 展开内容的 mapState, mapMutations, mapGettrs, mapActions
// 创建基于命名空间的组件绑定辅助函数 createNamespacedHelpers
export default {
  Store,
  install,
  version: '__VERSION__',
  mapState,
  mapMutations,
  mapGetters,
  mapActions,
  createNamespacedHelpers,
  createLogger
}

export {
  Store,
  install,
  mapState,
  mapMutations,
  mapGetters,
  mapActions,
  createNamespacedHelpers,
  createLogger
}
