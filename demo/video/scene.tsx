import { Layout, Rect, Txt, Video, makeScene2D } from "@revideo/2d";
import {
  all,
  createRef,
  easeInCubic,
  easeOutCubic,
  waitFor,
} from "@revideo/core";
import clipDurations from "./clips.json";

const BG = "#0a0a0a";
const ACCENT = "#f59e0b";
const TEXT = "#fafafa";
const MUTED = "#a3a3a3";
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

interface Chapter {
  src: string;
  duration: number;
  step: string;
  title: string;
  sub: string;
}

const CHAPTERS: Chapter[] = [
  {
    src: "/c1.mp4",
    duration: clipDurations.c1,
    step: "01",
    title: "Create a project",
    sub: "A project is a git repo of TypeScript — nothing more",
  },
  {
    src: "/c2.mp4",
    duration: clipDurations.c2,
    step: "02",
    title: "Ask the AI agent to build a workflow",
    sub: "The AI agent writes real code in a Cloudflare dev sandbox (sped up)",
  },
  {
    src: "/c3.mp4",
    duration: clipDurations.c3,
    step: "03",
    title: "Review the visual graph",
    sub: "The code is parsed into an interactive canvas",
  },
  {
    src: "/c4.mp4",
    duration: clipDurations.c4,
    step: "04",
    title: "Test-run it",
    sub: "Executed in a real sandbox, live results in the run panel",
  },
  {
    src: "/c5.mp4",
    duration: clipDurations.c5,
    step: "05",
    title: "Deploy",
    sub: "Commit + push straight to the project repo",
  },
  {
    src: "/c6.mp4",
    duration: clipDurations.c6,
    step: "06",
    title: "The code is the source of truth",
    sub: "The graph is just a projection of this TypeScript",
  },
];

export default makeScene2D("demo", function* (view) {
  view.fill(BG);

  // ------------------------------------------------------------- intro card
  const introTitle = createRef<Txt>();
  const introSub = createRef<Txt>();
  const introBadge = createRef<Rect>();

  view.add(
    <Layout direction="column" alignItems="center" gap={36} layout y={-20}>
      <Txt
        ref={introTitle}
        text="Catamorphic"
        fontFamily={FONT}
        fontSize={110}
        fontWeight={700}
        fill={TEXT}
        opacity={0}
      />
      <Txt
        ref={introSub}
        text="Users build workflows with AI — code-first, embedded in your product"
        fontFamily={FONT}
        fontSize={38}
        fill={MUTED}
        opacity={0}
      />
      <Rect
        ref={introBadge}
        fill="#27170a"
        stroke={ACCENT}
        lineWidth={2}
        radius={999}
        padding={[14, 34]}
        marginTop={20}
        opacity={0}
        layout
      >
        <Txt
          text="Playground demo · real agent, real sandbox, one take"
          fontFamily={FONT}
          fontSize={28}
          fill={ACCENT}
        />
      </Rect>
    </Layout>,
  );

  yield* all(
    introTitle().opacity(1, 0.7, easeOutCubic),
    introSub().opacity(1, 0.7, easeOutCubic),
  );
  yield* introBadge().opacity(1, 0.5, easeOutCubic);
  yield* waitFor(1.8);
  yield* all(
    introTitle().opacity(0, 0.45, easeInCubic),
    introSub().opacity(0, 0.45, easeInCubic),
    introBadge().opacity(0, 0.45, easeInCubic),
  );
  introTitle().parent().remove();

  // ------------------------------------------------------------- chapters
  for (const chapter of CHAPTERS) {
    const clip = createRef<Video>();
    const caption = createRef<Rect>();

    view.add(
      <Video
        ref={clip}
        src={chapter.src}
        size={[1600, 900]}
        y={-42}
        radius={18}
        clip
        opacity={0}
        scale={1.03}
      />,
    );

    view.add(
      <Rect
        ref={caption}
        fill="#161616"
        stroke="#2e2e2e"
        lineWidth={1.5}
        radius={16}
        padding={[18, 34]}
        y={478}
        opacity={0}
        layout
        direction="row"
        alignItems="center"
        gap={26}
      >
        <Txt
          text={chapter.step}
          fontFamily={FONT}
          fontSize={40}
          fontWeight={700}
          fill={ACCENT}
        />
        <Layout direction="column" gap={6} layout>
          <Txt
            text={chapter.title}
            fontFamily={FONT}
            fontSize={36}
            fontWeight={600}
            fill={TEXT}
          />
          <Txt
            text={chapter.sub}
            fontFamily={FONT}
            fontSize={25}
            fill={MUTED}
          />
        </Layout>
      </Rect>,
    );

    clip().play();
    yield* all(
      clip().opacity(1, 0.4, easeOutCubic),
      clip().scale(1, 0.5, easeOutCubic),
      caption().opacity(1, 0.4, easeOutCubic),
    );
    // Short clips (e.g. the near-instant deploy) hold their last frame so
    // every caption stays readable for at least ~4s.
    yield* waitFor(Math.max(chapter.duration - 0.85, 3.2));
    yield* all(
      clip().opacity(0, 0.35, easeInCubic),
      caption().opacity(0, 0.35, easeInCubic),
    );
    clip().remove();
    caption().remove();
  }

  // ------------------------------------------------------------- outro card
  const outroTitle = createRef<Txt>();
  const outroSub = createRef<Txt>();
  const outroFoot = createRef<Txt>();

  view.add(
    <Layout direction="column" alignItems="center" gap={34} layout y={-16}>
      <Txt
        ref={outroTitle}
        text="Embed it in your product."
        fontFamily={FONT}
        fontSize={84}
        fontWeight={700}
        fill={TEXT}
        opacity={0}
      />
      <Txt
        ref={outroSub}
        text="TypeScript in · visual graph out · sandboxed runs · git deploys"
        fontFamily={FONT}
        fontSize={36}
        fill={MUTED}
        opacity={0}
      />
      <Txt
        ref={outroFoot}
        text="Catamorphic — the embeddable workflow builder"
        fontFamily={FONT}
        fontSize={30}
        fill={ACCENT}
        opacity={0}
        marginTop={26}
      />
    </Layout>,
  );

  yield* all(
    outroTitle().opacity(1, 0.7, easeOutCubic),
    outroSub().opacity(1, 0.7, easeOutCubic),
  );
  yield* outroFoot().opacity(1, 0.5, easeOutCubic);
  yield* waitFor(2.4);
  yield* all(
    outroTitle().opacity(0, 0.5, easeInCubic),
    outroSub().opacity(0, 0.5, easeInCubic),
    outroFoot().opacity(0, 0.5, easeInCubic),
  );
});
