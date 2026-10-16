import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

export type YoutubeFixtureItem = { url: string; title: string; durationInSec?: number };

function searchHtml(items: YoutubeFixtureItem[]): string {
  const contents = items.map((item) => ({ videoRenderer: {
    videoId: new URL(item.url).searchParams.get("v"),
    title: { runs: [{ text: item.title }] },
    ownerText: { runs: [{ text: "Fixture artist", navigationEndpoint: { browseEndpoint: { browseId: "fixture", canonicalBaseUrl: "/@fixture" } } }] },
    lengthText: { simpleText: `${Math.floor((item.durationInSec || 180) / 60)}:${String((item.durationInSec || 180) % 60).padStart(2, "0")}` },
    thumbnail: { thumbnails: [{ url: "https://image.invalid/fixture", width: 120, height: 90 }] },
    channelThumbnailSupportedRenderers: { channelThumbnailWithLinkRenderer: { thumbnail: { thumbnails: [] } } },
  } }));
  const data = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents } }] } } } } };
  return `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
}

/** Exercise play-dl's real parser while preventing every outgoing HTTPS request. */
export function mockYoutubeSearch(handler: (query: string) => YoutubeFixtureItem[] | Promise<YoutubeFixtureItem[]>): () => void {
  const original = https.request;
  https.request = ((options: { host?: string; path?: string }, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; write: () => void };
    request.write = () => {};
    request.end = () => {
      void (async () => {
        if (options.host !== "www.youtube.com" || !options.path?.startsWith("/results?")) {
          throw new Error("Unexpected HTTPS request in offline YouTube fixture");
        }
        const query = new URL(`https://${options.host}${options.path}`).searchParams.get("search_query") || "";
        const response = Readable.from([searchHtml(await handler(query))]) as Readable & { statusCode: number; headers: Record<string, string> };
        response.statusCode = 200;
        response.headers = {};
        callback(response);
      })().catch((error) => request.emit("error", error));
    };
    return request;
  }) as typeof https.request;
  return () => { https.request = original; };
}
