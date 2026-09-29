/** "github.com" for "https://www.github.com/pulls": what a person calls the site. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The URL without its scheme or www., as people type it. */
export const bareUrl = (url: string): string =>
  url.replace(/^https?:\/\/(www\.)?/, "");
