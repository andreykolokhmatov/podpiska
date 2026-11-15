// Runs before paint inside the issue layout: a dark Telegram (tgWebAppThemeParams.bg_color in the
// launch hash) means a dark newspaper regardless of the OS setting. A server-forced theme wins.
export const THEME_SCRIPT =
  "(function(){try{var e=document.querySelector('.np');if(!e||e.dataset.theme)return;" +
  "var p=new URLSearchParams(location.hash.slice(1)).get('tgWebAppThemeParams');if(!p)return;" +
  'var c=JSON.parse(p).bg_color;if(!/^#[0-9a-f]{6}$/i.test(c))return;var n=parseInt(c.slice(1),16);' +
  "e.dataset.theme=(.299*(n>>16)+.587*(n>>8&255)+.114*(n&255))<128?'dark':'light'}catch(_){}})()";
