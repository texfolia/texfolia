import {
  appearanceStorageKey,
  catalogTheme,
  themeCatalog,
  resolveTheme,
} from "./themes";

export function isAppPath(pathname: string) {
  const path = pathname.replace(/\/+$/, "");
  return (
    path === "/projects" ||
    path.startsWith("/project/") ||
    path.startsWith("/accept-invitation/")
  );
}

const light = resolveTheme(catalogTheme("githubLight"));
const dark = resolveTheme(catalogTheme("githubDark"));

export function appearanceSnapshot(theme: ReturnType<typeof resolveTheme>) {
  return { mode: theme.mode, variables: theme.variables };
}

export function themeBootstrap(userId: string | null) {
  if (!userId) return "";
  const json = (value: unknown) =>
    JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  const hex = "#(?:[\\da-f]{3}|[\\da-f]{4}|[\\da-f]{6}|[\\da-f]{8})";
  const number = "(?:[0-9]{1,3}(?:\\.[0-9]+)?|\\.[0-9]+)";
  const color = `(?:${hex}|transparent|rgba?\\(\\s*${number}\\s*,\\s*${number}\\s*,\\s*${number}(?:\\s*,\\s*${number})?\\s*\\))`;
  const cachedColorPattern = `^(?:${color}|color-mix\\(in srgb, ${color} (?:100|[0-9]{1,2})%, ${color}\\))$`;
  return `(function(){
    var light=${json(appearanceSnapshot(light))},dark=${json(appearanceSnapshot(dark))};
    var ids=${json(themeCatalog.map((theme) => theme.id))};
    var theme=matchMedia('(prefers-color-scheme: dark)').matches?dark:light;
    try {
      var preference=JSON.parse(localStorage.getItem(${json(appearanceStorageKey(userId))})||'null');
      if(preference&&preference.selection&&preference.selection.kind==='theme'&&ids.indexOf(preference.selection.id)!==-1&&preference.preview){
        var cached=preference.preview;
        var color=new RegExp(${json(cachedColorPattern)},'i');
        if((cached.mode==='light'||cached.mode==='dark')&&cached.variables&&Object.keys(light.variables).every(function(key){
          return typeof cached.variables[key]==='string'&&color.test(cached.variables[key]);
        })) theme=cached;
      }
    } catch(error) {}
    var root=document.documentElement;
    root.classList.toggle('dark',theme.mode==='dark');
    root.style.colorScheme=theme.mode;
    Object.keys(light.variables).forEach(function(key){root.style.setProperty(key,theme.variables[key]);});
  })();`;
}

export function clearAppTheme(root: HTMLElement) {
  for (const key of Object.keys(light.variables))
    root.style.removeProperty(key);
  root.classList.remove("dark");
  root.style.removeProperty("color-scheme");
  delete root.dataset.appTheme;
}
