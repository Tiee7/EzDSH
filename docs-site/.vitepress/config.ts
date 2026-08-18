import { defineConfig } from 'vitepress'

const zhNav = [
  { text: '入门指南', link: '/guide/install' },
  { text: '免费 Tokens', link: '/guide/free-tokens' },
  { text: '远程控制', link: '/remote-control' },
  { text: '常见问题', link: '/faq' }
]

const enNav = [
  { text: 'Getting Started', link: '/en/guide/install' },
  { text: 'Remote Control', link: '/en/remote-control' },
  { text: 'FAQ', link: '/en/faq' }
]

const zhSidebar = [
  {
    text: '入门指南',
    items: [
      { text: '安装', link: '/guide/install' },
      { text: '首次使用', link: '/guide/first-run' },
      { text: '下载与更新', link: '/guide/update' },
      { text: '免费 Tokens', link: '/guide/free-tokens' }
    ]
  },
  { text: '远程控制', link: '/remote-control' },
  { text: '常见问题', link: '/faq' }
]

const enSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Installation', link: '/en/guide/install' },
      { text: 'First Run', link: '/en/guide/first-run' },
      { text: 'Download & Update', link: '/en/guide/update' }
    ]
  },
  { text: 'Remote Control', link: '/en/remote-control' },
  { text: 'FAQ', link: '/en/faq' }
]

export default defineConfig({
  title: 'EzDSH',
  description: 'EzDSH 帮助文档',
  lang: 'zh-CN',
  cleanUrls: true,
  lastUpdated: true,
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'EzDSH 帮助文档',
      description: 'DeepSeek Harness 桌面工作台 — 入门指南与常见问题',
      themeConfig: {
        nav: zhNav,
        sidebar: zhSidebar,
        search: {
          provider: 'local',
          options: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '未找到相关结果',
                resetButtonTitle: '清除查询条件',
                footer: {
                  selectText: '选择',
                  navigateText: '切换',
                  closeText: '关闭'
                }
              }
            }
          }
        }
      }
    },
    en: {
      label: 'English',
      lang: 'en',
      title: 'EzDSH Docs',
      description: 'DeepSeek Harness desktop workspace — getting started and FAQ',
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
        search: {
          provider: 'local'
        }
      }
    }
  }
})