/* Shared, dependency-free UI vocabulary for Mark's main process and both
   renderer windows. Keep keys semantic so a new surface does not scatter
   translated literals through input and drawing logic. */
(function exposeMarkLocale(root) {
  const catalog = {
    'zh-CN': {
      'language.chinese': '简体中文', 'language.english': 'English',
      'carrot.expand': '展开工具架', 'carrot.collapse': '收起工具架',
      'tool.pen': '铅笔', 'tool.eraser': '橡皮擦', 'tool.highlighter': '荧光笔', 'tool.text': '文字工具',
      'tool.clear': '清除所有笔迹', 'tool.screenshot': '矩形截图', 'tool.colors': '颜色', 'tool.settings': '设置',
      'panel.closeColors': '关闭颜色面板', 'panel.closeSettings': '关闭设置面板', 'panel.closeAbout': '关闭关于与版权',
      'panel.colors': '颜色', 'panel.settings': '设置', 'panel.colorChoice': '颜色选择',
      'color.red': '亮红', 'color.orange': '橙', 'color.yellow': '黄', 'color.green': '绿', 'color.blue': '蓝', 'color.purple': '紫',
      'color.black': '黑', 'color.white': '白', 'color.rose': '灰玫瑰', 'color.sage': '鼠尾草绿', 'color.mistBlue': '雾蓝', 'color.ochre': '陶土黄',
      'palette.stroke': '笔触', 'palette.width': '粗细', 'palette.strength': '强度', 'palette.pencil': '铅笔', 'palette.highlighter': '荧光笔',
      'settings.darkMode': '暗色模式', 'settings.style': '界面风格', 'settings.material': '拟物', 'settings.flat': '扁平',
      'settings.language': '语言', 'settings.compactMode': '紧凑模式', 'settings.boardMode': '画板模式', 'settings.board': '画板',
      'settings.whiteboard': '白板', 'settings.blackboard': '黑板', 'settings.autoHide': '自动收起', 'settings.delay': '延时',
      'settings.delayOptions': '自动收起延时', 'time.seconds': '{count} 秒',
      'about.title': '关于与版权', 'about.logo': '紫萝卜标识', 'about.subtitle': '轻盈的屏幕标注工具',
      'about.description': '在任意屏幕上留下轻盈、清晰的标注。', 'about.button': '关于与版权',
      'app.quit': '退出 ZhelongX / Mark', 'context.menu': '萝卜菜单', 'context.hide': '最小化到托盘', 'context.end': '结束本次标注',
      'screenshot.actions': '截图操作', 'screenshot.clipboard': '剪切板', 'screenshot.cancel': '取消', 'screenshot.save': '保存',
      'text.editor': '直接编辑文字', 'text.toolbar': '文字输入', 'text.decreaseSize': '减小字号', 'text.size': '字号',
      'text.increaseSize': '增大字号', 'text.color': '文字颜色', 'text.bold': '粗体', 'text.italic': '斜体',
      'tray.show': '显示工具架', 'tray.quit': '退出', 'dialog.saveScreenshot': '保存标注截图', 'dialog.pngImage': 'PNG 图片',
      'error.displayUnavailable': '目标显示器已不可用', 'error.displayRead': '无法读取目标显示器',
      'error.displayInactive': '目标显示器不是当前标注屏幕', 'error.captureFailed': '无法截图：{message}',
      'error.liveScreen': '无法读取实时屏幕', 'error.screenshotNotReady': '截图尚未准备好', 'error.composeScreenshot': '无法合成截图标注',
      'toast.copied': '选区已复制到剪切板', 'toast.saved': '截图已保存为 PNG'
    },
    en: {
      'language.chinese': 'Chinese (Simplified)', 'language.english': 'English',
      'carrot.expand': 'Expand tool rack', 'carrot.collapse': 'Collapse tool rack',
      'tool.pen': 'Pencil', 'tool.eraser': 'Eraser', 'tool.highlighter': 'Highlighter', 'tool.text': 'Text',
      'tool.clear': 'Clear all marks', 'tool.screenshot': 'Rectangular screenshot', 'tool.colors': 'Colors', 'tool.settings': 'Settings',
      'panel.closeColors': 'Close Colors panel', 'panel.closeSettings': 'Close Settings panel', 'panel.closeAbout': 'Close About & copyright',
      'panel.colors': 'Colors', 'panel.settings': 'Settings', 'panel.colorChoice': 'Color selection',
      'color.red': 'Bright red', 'color.orange': 'Orange', 'color.yellow': 'Yellow', 'color.green': 'Green', 'color.blue': 'Blue', 'color.purple': 'Purple',
      'color.black': 'Black', 'color.white': 'White', 'color.rose': 'Dusty rose', 'color.sage': 'Sage', 'color.mistBlue': 'Mist blue', 'color.ochre': 'Ochre',
      'palette.stroke': 'Stroke', 'palette.width': 'Width', 'palette.strength': 'Strength', 'palette.pencil': 'Pencil', 'palette.highlighter': 'Highlighter',
      'settings.darkMode': 'Dark mode', 'settings.style': 'Style', 'settings.material': 'Material', 'settings.flat': 'Flat',
      'settings.language': 'Language', 'settings.compactMode': 'Compact', 'settings.boardMode': 'Board mode', 'settings.board': 'Board',
      'settings.whiteboard': 'White', 'settings.blackboard': 'Black', 'settings.autoHide': 'Auto-hide', 'settings.delay': 'Delay',
      'settings.delayOptions': 'Auto-hide delay', 'time.seconds': '{count} sec',
      'about.title': 'About & copyright', 'about.logo': 'Purple radish logo', 'about.subtitle': 'A light screen annotation tool',
      'about.description': 'Leave light, clear annotations on any screen.', 'about.button': 'About & copyright',
      'app.quit': 'Quit ZhelongX / Mark', 'context.menu': 'Radish menu', 'context.hide': 'Hide to tray', 'context.end': 'End annotation',
      'screenshot.actions': 'Screenshot actions', 'screenshot.clipboard': 'Clipboard', 'screenshot.cancel': 'Cancel', 'screenshot.save': 'Save',
      'text.editor': 'Edit text directly', 'text.toolbar': 'Text input', 'text.decreaseSize': 'Decrease text size', 'text.size': 'Text size',
      'text.increaseSize': 'Increase text size', 'text.color': 'Text color', 'text.bold': 'Bold', 'text.italic': 'Italic',
      'tray.show': 'Show tool rack', 'tray.quit': 'Quit', 'dialog.saveScreenshot': 'Save annotated screenshot', 'dialog.pngImage': 'PNG image',
      'error.displayUnavailable': 'The target display is no longer available', 'error.displayRead': 'Unable to read the target display',
      'error.displayInactive': 'The target display is not the active annotation display', 'error.captureFailed': 'Screenshot failed: {message}',
      'error.liveScreen': 'Unable to read the live screen', 'error.screenshotNotReady': 'Screenshot is not ready', 'error.composeScreenshot': 'Unable to compose screenshot annotations',
      'toast.copied': 'Selection copied to the clipboard', 'toast.saved': 'Screenshot saved as PNG'
    }
  };

  function normalizeLanguage(value) { return value === 'en' ? 'en' : 'zh-CN'; }
  function text(language, key, values = {}) {
    const template = catalog[normalizeLanguage(language)]?.[key] ?? catalog['zh-CN'][key] ?? key;
    return String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
  }

  const api = Object.freeze({ catalog, normalizeLanguage, text });
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ZMarkLocale = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
