#!/usr/bin/env python3
"""Merge coverlet Cobertura reports from the sharded backend run and print the line coverage, in %.

A line is covered when ANY report hit it. The rate is covered / coverable over the union of every
report's (file, line) pairs, which is what coverlet reports for a single run — `--self-check`
proves that on one report: the merge of one file must equal that file's own `line-rate`.

  merge_coverage.py REPORT.xml...            -> e.g. 94.1
  merge_coverage.py --self-check REPORT.xml  -> exits non-zero if the merge disagrees with coverlet

Stdlib only.
"""
import sys
import xml.etree.ElementTree as ET


def lines_of(path):
    """{(filename, line number): hits} for one report. A line listed under two classes of the
    same file (a partial class, a compiler-generated state machine) is one line."""
    hits = {}
    for cls in ET.parse(path).getroot().iter("class"):
        filename = cls.get("filename")
        for line in cls.iter("line"):
            key = (filename, int(line.get("number")))
            hits[key] = max(hits.get(key, 0), int(line.get("hits")))
    return hits


def merged_rate(paths):
    union = {}
    for p in paths:
        for key, n in lines_of(p).items():
            union[key] = max(union.get(key, 0), n)
    if not union:
        sys.exit("no coverable lines in " + ", ".join(paths))
    return 100.0 * sum(1 for n in union.values() if n > 0) / len(union)


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    if args[0] == "--self-check":
        path = args[1]
        own = 100.0 * float(ET.parse(path).getroot().get("line-rate"))
        mine = merged_rate([path])
        print(f"coverlet {own:.2f}%  merge {mine:.2f}%")
        sys.exit(0 if abs(own - mine) < 0.05 else 1)
    print(f"{merged_rate(args):.1f}")


if __name__ == "__main__":
    main()
