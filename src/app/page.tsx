import { Suspense } from "react";
import type { CSSProperties } from "react";
import { PosterAppStream } from "@/components/poster-app";
import { getCellIds, posterConfig } from "@/lib/poster-config";
import { getPosterSnapshot } from "@/lib/poster-snapshot";

export const runtime = "nodejs";
export const preferredRegion = "sfo1";
export const dynamic = "force-dynamic";

export default function Home() {
  const snapshotPromise = getPosterSnapshot();

  return (
    <Suspense fallback={<PosterFallback />}>
      <PosterAppStream snapshotPromise={snapshotPromise} />
    </Suspense>
  );
}

function PosterFallback() {
  const config = posterConfig;

  return (
    <main className="app toolbarHidden">
      <div className="posterExperience">
        <aside className="posterInvite noPrint" aria-label="Invitation note">
          <svg
            className="posterInviteArrow posterInviteArrowDesktop"
            viewBox="0 0 170 86"
            aria-hidden="true"
          >
            <path d="M160 24C122 24 86 33 43 59" />
            <path d="M43 59C57 51 64 43 70 33" />
            <path d="M43 59C58 60 67 66 76 76" />
          </svg>
          <svg
            className="posterInviteArrow posterInviteArrowMobile"
            viewBox="0 0 128 96"
            aria-hidden="true"
          >
            <path d="M40 8C52 35 69 52 77 80" />
            <path d="M77 80C67 70 57 66 44 65" />
            <path d="M77 80C83 67 91 58 103 52" />
          </svg>
          <p>kathy and john are printing this as a poster for their home</p>
          <p>would love for you to draw</p>
          <p className="posterInviteSize">
            printing at {formatPosterSize(config)}.
          </p>
        </aside>
        <section className="stage" aria-label="Collaborative poster">
          <div
            className="poster"
            style={
              {
                "--poster-width": config.posterWidthIn,
                "--poster-height": config.posterHeightIn,
                "--title-height": config.titleHeightIn,
                "--columns": config.columns,
                "--rows": config.rows,
                "--grid-width-percent": `${
                  (config.gridWidthIn / config.posterWidthIn) * 100
                }%`,
                "--grid-height-percent": `${
                  (config.gridHeightIn /
                    (config.posterHeightIn - config.titleHeightIn)) *
                  100
                }%`,
              } as CSSProperties
            }
          >
            <header className="posterTitle">{config.title}</header>
            <div className="posterGrid">
              {getCellIds(config).map((cellId) => (
                <div
                  key={cellId}
                  className="cell available posterFallbackCell"
                  aria-hidden="true"
                />
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function formatPosterSize(config: typeof posterConfig) {
  return `${formatInches(config.posterWidthIn)}" x ${formatInches(
    config.posterHeightIn,
  )}"`;
}

function formatInches(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
