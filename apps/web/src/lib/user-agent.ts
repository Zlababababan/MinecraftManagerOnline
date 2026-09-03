/**
 * Résumé lisible d'un user-agent (lot 8, « appareils connectés ») : « Firefox · Windows ».
 * Volontairement grossier — le but est de reconnaître SON appareil, pas d'identifier un visiteur.
 */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\/\d/i, 'Edge'],
  [/\bOPR\/\d|\bOpera\b/i, 'Opera'],
  [/\bSamsungBrowser\/\d/i, 'Samsung Internet'],
  [/\bFirefox\/\d|\bFxiOS\/\d/i, 'Firefox'],
  [/\bCriOS\/\d|\bChrome\/\d|\bChromium\/\d/i, 'Chrome'],
  [/\bSafari\/\d/i, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\bWindows\b/i, 'Windows'],
  [/\bAndroid\b/i, 'Android'],
  [/\biPhone\b|\biPod\b/i, 'iPhone'],
  [/\biPad\b/i, 'iPad'],
  [/\bMac OS X\b|\bMacintosh\b/i, 'macOS'],
  [/\bCrOS\b/i, 'ChromeOS'],
  [/\bLinux\b/i, 'Linux'],
];

export function describeUserAgent(
  userAgent: string | null | undefined,
): { browser: string | undefined; os: string | undefined } | undefined {
  if (userAgent === null || userAgent === undefined || userAgent.trim() === '') return undefined;
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const os = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  if (browser === undefined && os === undefined) return undefined;
  return { browser, os };
}

/** « Firefox · Windows », « Safari · iPhone », ou `undefined` quand rien n'est reconnaissable. */
export function summarizeUserAgent(userAgent: string | null | undefined): string | undefined {
  const d = describeUserAgent(userAgent);
  if (d === undefined) return undefined;
  return [d.browser, d.os].filter((x): x is string => x !== undefined).join(' · ');
}
