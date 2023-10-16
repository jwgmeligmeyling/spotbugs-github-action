import * as core from '@actions/core'
import {BugPattern, FindbugsResult, SourceLine} from './spotbugs'
import {XMLParser} from 'fast-xml-parser'
import fs from 'fs'
import BufferEncoding from 'buffer'
import * as path from 'path'
import {Annotation, AnnotationLevel} from './github'
import {convert as htmlToText, HtmlToTextOptions} from 'html-to-text'
import decode from 'unescape'
import {memoizeWith, identity, indexBy, chain} from 'ramda'

const HTML_TO_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  preserveNewlines: false
}

const XML_PARSE_OPTIONS = {
  allowBooleanAttributes: true,
  ignoreAttributes: false,
  attributeNamePrefix: ''
}

function asArray<T>(arg: T[] | T | undefined): T[] {
  return !arg ? [] : Array.isArray(arg) ? arg : [arg]
}

export function annotationsForPath(resultFile: string): Annotation[] {
  core.info(`Creating annotations for ${resultFile}`)
  const root: string = process.env['GITHUB_WORKSPACE'] || ''

  const parser = new XMLParser(XML_PARSE_OPTIONS)
  const result: FindbugsResult = parser.parse(
    fs.readFileSync(resultFile, 'UTF-8' as BufferEncoding)
  )
  const violations = asArray(result?.BugCollection?.BugInstance)
  const bugPatterns: {[type: string]: BugPattern} = indexBy(
    a => a.type,
    asArray(result?.BugCollection?.BugPattern)
  )
  core.info(`${resultFile} has ${violations.length} violations`)

  const getFilePath: (sourcePath: string) => string | undefined = memoizeWith(
    identity,
    (sourcePath: string) =>
      asArray(result?.BugCollection?.Project?.SrcDir).find(SrcDir => {
        const combinedPath = path.join(SrcDir, sourcePath)
        const fileExists = fs.existsSync(combinedPath)
        core.debug(`${combinedPath} ${fileExists ? 'does' : 'does not'} exists`)
        return fileExists
      })
  )

  return chain(BugInstance => {
    const annotationsForBug: Annotation[] = []
    const sourceLines = asArray(BugInstance.SourceLine)
    const primarySourceLine: SourceLine | undefined =
      sourceLines.length > 1
        ? sourceLines.find(sl => sl.primary)
        : sourceLines[0]
    const SrcDir: string | undefined =
      primarySourceLine?.sourcepath &&
      getFilePath(primarySourceLine?.sourcepath)

    if (primarySourceLine?.start && SrcDir) {
      const annotation: Annotation = {
        annotation_level: AnnotationLevel.warning,
        path: path.relative(
          root,
          path.join(SrcDir, primarySourceLine?.sourcepath)
        ),
        start_line: Number(primarySourceLine?.start || 1),
        end_line: Number(
          primarySourceLine?.end || primarySourceLine?.start || 1
        ),
        title: BugInstance.type,
        message: BugInstance.LongMessage,
        raw_details: htmlToText(
          decode(bugPatterns[BugInstance.type].Details),
          HTML_TO_TEXT_OPTIONS
        )
      }
      annotationsForBug.push(annotation)
    } else {
      core.debug(
        `Skipping bug instance because source line start or source directory are missing`
      )
    }

    return annotationsForBug
  }, violations)
}
