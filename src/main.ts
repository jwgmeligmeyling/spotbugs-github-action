import * as core from '@actions/core'
import {findResults} from './search'
import {Inputs} from './constants'
import {annotationsForPath} from './annotations'
import {chain, splitEvery} from 'ramda'
import {Annotation} from './github'
import {getOctokit, context} from '@actions/github'

const MAX_ANNOTATIONS_PER_REQUEST = 50

async function run(): Promise<void> {
  try {
    const path = core.getInput(Inputs.Path, {required: true})
    const name = core.getInput(Inputs.Name)
    const title = core.getInput(Inputs.Title)
    const threshold = Number(core.getInput(Inputs.Threshold))

    const searchResult = await findResults(path)
    if (searchResult.filesToUpload.length === 0) {
      core.warning(
        `No files were found for the provided path: ${path}. No results will be uploaded.`
      )
    } else {
      core.info(
        `With the provided path, there will be ${searchResult.filesToUpload.length} results uploaded`
      )
      core.debug(`Root artifact directory is ${searchResult.rootDirectory}`)

      const annotations: Annotation[] = chain(
        annotationsForPath,
        searchResult.filesToUpload
      )
      core.debug(
        `Grouping ${annotations.length} annotations into chunks of ${MAX_ANNOTATIONS_PER_REQUEST}`
      )

      const groupedAnnotations: Annotation[][] =
        annotations.length > MAX_ANNOTATIONS_PER_REQUEST
          ? splitEvery(MAX_ANNOTATIONS_PER_REQUEST, annotations)
          : [annotations]

      core.debug(`Created ${groupedAnnotations.length} buckets`)

      let totalErrors = 0
      for (const annotationSet of groupedAnnotations) {
        if (annotationSet.length > 0) {
          await createCheck(name, title, annotationSet)
          totalErrors = totalErrors + annotationSet.length
        }
      }
      if (totalErrors !== threshold) {
        core.setFailed(`${totalErrors} violation(s) uploaded`)
      }
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error : String(error))
  }
}

async function createCheck(
  name: string,
  title: string,
  annotations: Annotation[]
): Promise<void> {
  core.debug(`Upload ${annotations.length} Annotations`)
  const octokit = getOctokit(core.getInput(Inputs.Token))
  let sha = context.sha

  if (context.payload.pull_request) {
    sha = context.payload.pull_request.head.sha
  }

  const req = {
    ...context.repo,
    ref: sha
  }

  const res = await octokit.checks.listForRef(req)
  if (core.isDebug()) {
    for (const checkRun of res.data.check_runs) {
      core.debug(`${checkRun.name}`)
    }
  }
  const existingCheckRun = res.data.check_runs.find(
    check => check.name === name
  )

  const status = <const>'completed'
  const numErrors = annotations.length
  const summary = `${numErrors} violation(s) found`
  const conclusion = <const>'neutral'
  if (!existingCheckRun) {
    const createRequest = {
      ...context.repo,
      head_sha: sha,
      name,
      status,
      conclusion,
      output: {
        title,
        summary,
        annotations
      }
    }

    core.debug(`First upload`)
    await octokit.checks.create(createRequest)
  } else {
    const checkRunId = existingCheckRun.id
    const updateReq = {
      ...context.repo,
      check_run_id: checkRunId,
      status,
      conclusion,
      output: {
        title,
        summary,
        annotations
      }
    }

    core.debug(`another upload`)
    await octokit.checks.update(updateReq)
  }
}

run()
