import {
  appearanceStorageKey,
  bundledThemes,
  colorPattern,
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

const light = resolveTheme(bundledThemes.texfolia);
const dark = resolveTheme(bundledThemes.vscodeDark);

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
  // All property names come from the compiler. Cached values are constrained to
  // hex or the compiler's color-mix grammar before touching the document.
  const cachedColorPattern = `^(?:${colorPattern}|color-mix\\(in srgb, ${colorPattern} (?:100|[0-9]{1,2})%, ${colorPattern}\\))$`;
  return `(function(){
    var light=${json(appearanceSnapshot(light))},dark=${json(appearanceSnapshot(dark))};
    var theme=matchMedia('(prefers-color-scheme: dark)').matches?dark:light;
    try {
      var preference=JSON.parse(localStorage.getItem(${json(appearanceStorageKey(userId))})||'null');
      if(preference&&preference.selection&&preference.selection.kind!=='system'&&preference.preview){
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
