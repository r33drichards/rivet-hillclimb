"""Narrated, vector-only explainer for the durable PR hillclimb agent.

Render from the repository root:
    .local/manim-venv/bin/manim -qh --fps 30 video/hillclimb.py HillclimbExplainer
Narration and measured durations come from video/scenes.json. No network calls.
"""
from __future__ import annotations

import json
from pathlib import Path
import numpy as np
from manim import *

config.background_color = "#10151F"
config.frame_width = 128 / 9
config.frame_height = 8

ROOT = Path(__file__).resolve().parent
BLUE = "#69B9FF"
YELLOW = "#FFD166"
GREEN = "#70D6AC"
RED = "#FF7B88"
PURPLE = "#B69AFF"
INK = "#EAF1FF"
MUTED = "#9BAAC4"
PANEL = "#182232"
LINE = "#34445C"


def text(value, size=28, color=INK, **kw):
    return Text(value, font="Sans", font_size=size, color=color, **kw)


def pill(value, color=BLUE, width=None):
    label = text(value, 22, color)
    box = RoundedRectangle(width=width or label.width + .42, height=.52,
                           corner_radius=.16, stroke_color=color,
                           stroke_width=1.4, fill_color=color, fill_opacity=.09)
    return VGroup(box, label)


def panel(value, position, width=3, height=1.4, color=BLUE, subtitle=None):
    box = RoundedRectangle(width=width, height=height, corner_radius=.18,
                           stroke_color=color, stroke_width=1.6,
                           fill_color=PANEL, fill_opacity=1)
    title = text(value, 26, color)
    if subtitle:
        title.shift(UP * .22)
        sub = text(subtitle, 18, MUTED).shift(DOWN * .29)
        contents = VGroup(box, title, sub)
    else:
        contents = VGroup(box, title)
    return contents.move_to(position)


def connection(a, b, color=MUTED, buff=.16):
    return Arrow(a, b, buff=buff, color=color, stroke_width=2.2,
                 max_tip_length_to_length_ratio=.12)


def cross_at(point, scale=.20, color=RED):
    return VGroup(Line(UL * scale, DR * scale), Line(DL * scale, UR * scale)).set_color(color).set_stroke(width=4).move_to(point)


def tick_at(point, color=GREEN):
    return VMobject().set_points_as_corners([[-.15, 0, 0], [-.035, -.12, 0], [.19, .16, 0]]).set_stroke(color, 4).move_to(point)


class HillclimbExplainer(Scene):
    def construct(self):
        self.timings = []
        manifest = ROOT / "scenes.json"
        if manifest.exists():
            data = json.loads(manifest.read_text())
            self.entries = data if isinstance(data, list) else data["scenes"]
        else:
            self.entries = [{"id": i + 1, "duration": 15, "title": ""} for i in range(8)]
        sections = [self.loop, self.signal, self.actors, self.feedback,
                    self.sleep, self.conflicts, self.conversation, self.cancel]
        for index, draw in enumerate(sections):
            entry = self.entries[index]
            start = self.time
            audio = entry.get("audio")
            if audio:
                audio_path = Path(audio)
                if not audio_path.is_absolute():
                    candidates = [Path.cwd() / audio_path, ROOT / audio_path,
                                  ROOT / "audio" / audio_path.name]
                    audio_path = next((p for p in candidates if p.exists()), candidates[0])
                if audio_path.exists():
                    self.add_sound(str(audio_path), gain=0)
            draw(index)
            # Each chapter owns its full clock, including its exit transition.
            duration = float(entry.get("duration", 15))
            elapsed = self.time - start
            self.wait(max(.15, duration - elapsed - .65))
            self.play(*[FadeOut(m) for m in list(self.mobjects)], run_time=.65)
            self.timings.append({"id": entry.get("id", index + 1),
                                 "start": round(start, 3),
                                 "end": round(self.time, 3),
                                 "duration": round(self.time - start, 3)})
        (ROOT / "render-timing.json").write_text(json.dumps(self.timings, indent=2))

    def header(self, index, title, takeaway):
        eyebrow = text("DURABLE PR AGENTS", 15, MUTED).to_corner(UL, buff=.44)
        number = text(f"{index + 1:02d} / 08", 15, MUTED).to_corner(UR, buff=.44)
        heading = text(title, 37).move_to([0, 2.87, 0])
        rule = Line([-6.45, -3.12, 0], [6.45, -3.12, 0], color=LINE, stroke_width=1)
        footer = text(takeaway, 21, MUTED).move_to([0, -3.51, 0])
        if footer.width > 12.5:
            footer.scale_to_fit_width(12.5)
        self.play(FadeIn(eyebrow), FadeIn(number), FadeIn(heading, shift=UP * .12),
                  FadeIn(rule), FadeIn(footer), run_time=.65)

    def loop(self, index):
        self.header(index, "Progress is a feedback loop", "Every step must earn its evidence.")
        points = [np.array([x, y, 0]) for x, y in
                  [(-5, -.65), (-3.4, -.65), (-3.4, -.05), (-1.7, -.05),
                   (-1.7, .55), (.1, .55), (.1, 1.15), (2, 1.15), (2, 1.75), (4.4, 1.75)]]
        stair = VMobject().set_points_as_corners(points).set_stroke(BLUE, 3)
        axis = Line([-5.35, -1, 0], [-5.35, 2, 0], color=LINE)
        evidence = text("verified\nprogress", 19, MUTED).next_to(axis, LEFT, buff=.25)
        dot = Dot(points[0], radius=.105, color=YELLOW)
        self.play(Create(stair), FadeIn(axis), FadeIn(evidence), FadeIn(dot), run_time=1.4)
        for end in [2, 4, 6, 9]:
            target = points[end]
            self.play(dot.animate.move_to(target), run_time=.55)
            self.play(Flash(target, color=YELLOW, flash_radius=.24, line_length=.10), run_time=.35)
        labels = ["INSPECT", "EDIT", "PUSH", "FEEDBACK"]
        nodes = VGroup(*[panel(v, [x, -1.98, 0], 2.48, .86, BLUE if i < 3 else GREEN)
                         for i, (v, x) in enumerate(zip(labels, [-4.65, -1.55, 1.55, 4.65]))])
        arrows = VGroup(*[connection(nodes[i].get_right(), nodes[i + 1].get_left()) for i in range(3)])
        self.play(LaggedStart(*[FadeIn(n, shift=UP * .12) for n in nodes], lag_ratio=.18), run_time=1.25)
        self.play(LaggedStart(*[GrowArrow(a) for a in arrows], lag_ratio=.2), run_time=1)
        self.play(Indicate(nodes[-1], color=GREEN), run_time=.8)

    def signal(self, index):
        self.header(index, "One label starts the loop", "An owner event becomes a scheduled turn.")
        pr = panel("Pull request", [-4.5, .15, 0], 3.6, 2.5, BLUE)
        pr[1].shift(UP * .66)
        rows = VGroup(*[Line([-5.77, y, 0], [-3.25 + .2 * i, y, 0], color=LINE, stroke_width=3)
                         for i, y in enumerate([.3, -.05, -.4])])
        tag = pill("codex-hillclimb", YELLOW, 3.18).move_to([-4.5, -.78, 0])
        coordinator = panel("Coordinator", [.05, .15, 0], 2.8, 1.35, PURPLE, "persist + schedule")
        runner = panel("Runner", [4.45, .15, 0], 2.7, 1.35, BLUE, "one PR")
        arrows = VGroup(connection(pr.get_right(), coordinator.get_left()),
                        connection(coordinator.get_right(), runner.get_left()))
        self.play(FadeIn(pr), Create(rows), run_time=.9)
        self.play(FadeIn(tag, scale=.8), run_time=.7)
        self.play(FadeIn(coordinator), GrowArrow(arrows[0]), run_time=.8)
        pulse = Dot(arrows[0].get_start(), radius=.08, color=YELLOW)
        self.add(pulse)
        self.play(MoveAlongPath(pulse, arrows[0]), run_time=.8)
        self.play(FadeIn(runner), GrowArrow(arrows[1]), run_time=.8)
        self.play(MoveAlongPath(pulse, arrows[1]), run_time=.8)
        self.play(Flash(runner.get_center(), color=BLUE, flash_radius=.75), FadeOut(pulse), run_time=.7)
        scope = VGroup(pill("r33drichards repositories", MUTED), pill("owner-applied label", YELLOW)).arrange(RIGHT, buff=.45).move_to([0, -1.9, 0])
        self.play(FadeIn(scope), run_time=.75)

    def actors(self, index):
        self.header(index, "A mind and a workspace", "Durable state survives sleep and restart.")
        positions = [np.array([-3.35, .05, 0]), np.array([3.35, .05, 0])]
        halos = VGroup(*[Circle(1.53, color=PURPLE, stroke_width=2, stroke_opacity=.55).move_to(p) for p in positions])
        bodies = VGroup(*[Circle(1.38, color=BLUE, stroke_width=2, fill_color=PANEL, fill_opacity=1).move_to(p) for p in positions])
        titles = VGroup(text("RUNNER", 27, BLUE).move_to(positions[0] + UP * .77),
                        text("MCP-JS", 27, BLUE).move_to(positions[1] + UP * .77))
        conversation = VGroup(*[RoundedRectangle(width=1.6 - .17 * i, height=.25, corner_radius=.07,
                                  stroke_width=0, fill_color=BLUE, fill_opacity=.5).shift(DOWN * .43 * i)
                                for i in range(3)]).move_to(positions[0] + DOWN * .15)
        files = VGroup(*[text(line, 21, MUTED) for line in ["repo/", "  src/", "  .git/"]]).arrange(DOWN, aligned_edge=LEFT, buff=.13).move_to(positions[1] + DOWN * .18)
        arrow = DoubleArrow(positions[0] + RIGHT * 1.65, positions[1] + LEFT * 1.65, color=YELLOW, buff=.06, stroke_width=2)
        self.play(FadeIn(bodies), FadeIn(titles), run_time=.9)
        self.play(FadeIn(conversation), FadeIn(files), GrowArrow(arrow), run_time=1)
        captions = VGroup(text("conversation", 23, MUTED).move_to([-3.35, -1.93, 0]),
                          text("real clone + JavaScript", 23, MUTED).move_to([3.35, -1.93, 0]))
        self.play(FadeIn(captions), Create(halos), run_time=1)
        saved = pill("checkpoint", PURPLE).move_to([0, -2.4, 0])
        self.play(FadeIn(saved), run_time=.5)
        for _ in range(2):
            self.play(*[h.animate.scale(1.07).set_stroke(opacity=.9) for h in halos], run_time=.6)
            self.play(*[h.animate.scale(1 / 1.07).set_stroke(opacity=.55) for h in halos], run_time=.6)
        self.play(bodies.animate.set_opacity(.32), conversation.animate.set_opacity(.32), files.animate.set_opacity(.32), run_time=.7)
        self.play(bodies.animate.set_opacity(1), conversation.animate.set_opacity(1), files.animate.set_opacity(1), run_time=.7)

    def feedback(self, index):
        self.header(index, "CI is the measuring instrument", "Builds and tests run in GitHub Actions.")
        clone = panel("workspace", [-4.7, .4, 0], 2.7, 1.5, BLUE, "edit a focused diff")
        commit = Circle(.55, color=YELLOW, fill_color=PANEL, fill_opacity=1).move_to([-.95, .4, 0])
        sha = text("a1b2c3", 21, YELLOW).next_to(commit, DOWN, buff=.28)
        gha = panel("GitHub Actions", [3.8, .4, 0], 3.9, 2.45, PURPLE)
        gha[1].shift(UP * .65)
        checks = VGroup(*[pill(v, MUTED, 1.02) for v in ["lint", "types", "tests"]]).arrange(RIGHT, buff=.15).move_to([3.8, .05, 0])
        a1 = connection(clone.get_right(), commit.get_left())
        a2 = connection(commit.get_right(), gha.get_left())
        self.play(FadeIn(clone), run_time=.6)
        self.play(GrowArrow(a1), Create(commit), FadeIn(sha), run_time=1)
        self.play(GrowArrow(a2), FadeIn(gha), FadeIn(checks), run_time=1)
        pulse = Dot(commit.get_center(), radius=.08, color=YELLOW)
        self.add(pulse)
        self.play(MoveAlongPath(pulse, a2), FadeOut(pulse), run_time=1)
        for i in range(3):
            check = tick_at(checks[i].get_center() + DOWN * .65)
            self.play(FadeIn(check), checks[i].animate.set_color(GREEN), run_time=.55)
        no_local = pill("no local build / test loop", MUTED).move_to([-2.6, -1.65, 0])
        sha_note = text("results belong to a commit", 26, YELLOW).move_to([2.4, -1.65, 0])
        self.play(FadeIn(no_local), FadeIn(sha_note), run_time=.8)
        link = DashedLine(sha.get_bottom(), sha_note.get_top(), color=YELLOW, stroke_width=1.4)
        self.play(Create(link), run_time=.7)

    def sleep(self, index):
        self.header(index, "Waiting is a state", "Wake for evidence. Never wake merely because of a push.")
        runner = panel("Runner", [-4.75, .35, 0], 2.8, 1.3, BLUE, "saved + asleep")
        halo = RoundedRectangle(width=3.03, height=1.53, corner_radius=.25, color=PURPLE, stroke_opacity=.55).move_to(runner)
        self.play(FadeIn(runner), Create(halo), run_time=.7)
        self.play(runner.animate.set_opacity(.35), run_time=.6)
        coordinator = Dot([-1.1, -.25, 0], color=PURPLE, radius=.16)
        coord_text = text("coordinator", 19, PURPLE).next_to(coordinator, DOWN, buff=.3)
        self.play(FadeIn(coordinator), FadeIn(coord_text), run_time=.6)
        old = VGroup(text("old SHA", 21, MUTED), *[Square(.38, color=GREEN, fill_color=GREEN, fill_opacity=.3) for _ in range(3)]).arrange(RIGHT, buff=.24).move_to([3.35, 1.2, 0])
        current = VGroup(text("current SHA", 21, YELLOW), *[Square(.38, color=MUTED) for _ in range(3)]).arrange(RIGHT, buff=.24).move_to([3.35, -.05, 0])
        self.play(FadeIn(old), FadeIn(current), run_time=.9)
        reject = cross_at(old.get_right() + RIGHT * .4)
        self.play(Create(reject), old.animate.set_opacity(.3), run_time=.7)
        for tile in list(current)[1:3]:
            self.play(tile.animate.set_color(GREEN).set_fill(GREEN, opacity=.45), run_time=.5)
        waiting = text("still waiting…", 21, MUTED).move_to([3.6, -.87, 0])
        self.play(FadeIn(waiting), run_time=.5)
        self.wait(.5)
        self.play(current[-1].animate.set_color(RED).set_fill(RED, opacity=.45), FadeOut(waiting), run_time=.5)
        terminal = text("all terminal ≠ all passing", 21, YELLOW).move_to([3.4, -.87, 0])
        self.play(FadeIn(terminal), run_time=.5)
        wake = connection(coordinator.get_left(), runner.get_right(), YELLOW)
        self.play(GrowArrow(wake), run_time=.5)
        self.play(runner.animate.set_opacity(1), Flash(runner.get_center(), color=BLUE, flash_radius=.7), run_time=.75)
        push = VGroup(pill("push", MUTED), connection([0, 0, 0], [1.7, 0, 0]), cross_at([1.05, 0, 0])).arrange(RIGHT, buff=.2).move_to([0, -2.1, 0])
        push_caption = text("not a wake signal", 22, MUTED).next_to(push, RIGHT, buff=.3)
        group = VGroup(push, push_caption).move_to([0, -2.1, 0])
        self.play(FadeIn(group), run_time=.7)

    def conflicts(self, index):
        self.header(index, "Conflicts wake it. Limits bound it.", "Three attempts per failure. Ten fix iterations overall.")
        base = Line([-5.8, .8, 0], [-.7, .8, 0], color=BLUE, stroke_width=3)
        branch = VMobject().set_points_as_corners([[-5.1, .8, 0], [-3.9, -.25, 0], [-.7, -.25, 0]]).set_stroke(PURPLE, 3)
        knot = Circle(.34, color=RED, stroke_width=3).move_to([-.2, .25, 0])
        joins = VGroup(Line(base.get_end(), knot.get_top(), color=BLUE), Line(branch.get_end(), knot.get_bottom(), color=PURPLE))
        self.play(Create(base), Create(branch), run_time=1)
        self.play(Create(joins), Create(knot), run_time=.7)
        confirmed = pill("confirmed conflict", RED).move_to([-3.4, -1.2, 0])
        runner = panel("Resume runner", [3.8, .4, 0], 3.7, 1.35, BLUE)
        arrow = connection(knot.get_right(), runner.get_left(), YELLOW)
        self.play(FadeIn(confirmed), FadeIn(runner), GrowArrow(arrow), run_time=1)
        tries = VGroup(*[Circle(.12, color=YELLOW, fill_color=YELLOW, fill_opacity=.8) for _ in range(3)]).arrange(RIGHT, buff=.24)
        tries_label = text("attempts / failure", 20, MUTED)
        tries_group = VGroup(tries, tries_label).arrange(DOWN, buff=.22).move_to([2.1, -1.37, 0])
        fixes = VGroup(*[Circle(.065, color=PURPLE, fill_color=PURPLE, fill_opacity=.7) for _ in range(10)]).arrange(RIGHT, buff=.12)
        fixes_label = text("total fix iterations", 20, MUTED)
        fixes_group = VGroup(fixes, fixes_label).arrange(DOWN, buff=.22).move_to([4.8, -1.37, 0])
        self.play(LaggedStart(*[FadeIn(d) for d in tries], lag_ratio=.25), FadeIn(tries_label), run_time=.9)
        self.play(LaggedStart(*[FadeIn(d) for d in fixes], lag_ratio=.08), FadeIn(fixes_label), run_time=.9)
        skip = text("Infrastructure / missing secrets → report and stop", 22, MUTED).move_to([0, -2.48, 0])
        self.play(FadeIn(skip), run_time=.65)

    def conversation(self, index):
        self.header(index, "The PR is the control surface", "Only new owner comments become commands.")
        owner = pill("r33drichards", YELLOW).move_to([-4.9, 1.58, 0])
        status = panel("/hillclimb status", [-3.65, .5, 0], 5.1, .95, YELLOW)
        question = panel("/hillclimb explain the failure", [-3.65, -1.05, 0], 5.1, .95, YELLOW)
        status[1].scale(.83)
        question[1].scale(.75)
        direct = panel("Current state", [3.65, .5, 0], 3.6, .95, PURPLE)
        response = panel("Agent reply", [3.65, -1.05, 0], 3.6, .95, BLUE)
        arrow1 = connection(status.get_right(), direct.get_left(), PURPLE)
        arrow2 = connection(question.get_right(), response.get_left(), BLUE)
        self.play(FadeIn(owner), FadeIn(status, shift=RIGHT * .2), run_time=.8)
        self.play(GrowArrow(arrow1), FadeIn(direct), run_time=.8)
        no_model = text("no inference needed", 18, MUTED).next_to(direct, DOWN, buff=.18)
        self.play(FadeIn(no_model), run_time=.5)
        self.play(FadeIn(question, shift=RIGHT * .2), run_time=.6)
        queue = VGroup(*[Line([x, -1.05, 0], [x, -.75, 0], color=BLUE, stroke_width=3) for x in [-.65, -.35, -.05]])
        self.play(Create(queue), run_time=.6)
        self.play(FadeOut(queue), GrowArrow(arrow2), FadeIn(response), run_time=.9)
        status_comment = text("One status comment follows the run", 24, MUTED).move_to([0, -2.45, 0])
        self.play(FadeIn(status_comment), run_time=.6)

    def cancel(self, index):
        self.header(index, "A loop with a stop switch", "Remove the label, close the PR, or use /hillclimb stop.")
        labels = ["Queued", "Running", "Waiting for CI"]
        nodes = VGroup(*[panel(v, [x, .55, 0], 3.35, 1.05, BLUE if i < 2 else PURPLE)
                         for i, (v, x) in enumerate(zip(labels, [-4.3, 0, 4.3]))])
        arrows = VGroup(*[connection(nodes[i].get_right(), nodes[i + 1].get_left()) for i in range(2)])
        self.play(FadeIn(nodes), *[GrowArrow(a) for a in arrows], run_time=1)
        tag = pill("codex-hillclimb", YELLOW).move_to([0, 1.8, 0])
        self.play(FadeIn(tag), run_time=.5)
        stop = cross_at(tag.get_center(), scale=.38)
        self.play(Create(stop), tag.animate.set_opacity(.25), run_time=.7)
        cancelled = panel("CANCELLED", [0, -.8, 0], 3.6, .9, RED)
        cancellations = VGroup(*[connection(n.get_bottom(), cancelled.get_top(), RED, buff=.12) for n in nodes])
        self.play(*[GrowArrow(a) for a in cancellations], FadeIn(cancelled), nodes.animate.set_opacity(.3), arrows.animate.set_opacity(.2), run_time=1)
        remaining = VGroup(pill("existing commits", MUTED), pill("started CI jobs", MUTED)).arrange(RIGHT, buff=.35).move_to([0, -1.95, 0])
        remains = text("remain intact", 20, MUTED).next_to(remaining, DOWN, buff=.19)
        self.play(FadeIn(remaining), FadeIn(remains), run_time=.8)
        restart = text("Re-add the label → restart", 25, GREEN).move_to([0, 1.8, 0])
        self.play(FadeOut(tag), FadeOut(stop), FadeIn(restart), run_time=.8)
        self.play(Indicate(cancelled, color=RED), run_time=.7)
