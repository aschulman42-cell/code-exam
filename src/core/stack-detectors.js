// stack-detectors.js — detects the ops stack (Containers, Kubernetes, IaC, Cloud, CI/CD), tagging hits mechanical or heuristic
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * stack-detectors.js — non-AI/ML "operational stack" detection (#168).
 *
 * Powers the Infrastructure accordion: file-shape detectors for the
 * deployment/ops stack — Containers, Kubernetes, IaC, CI/CD. Deliberately
 * file-shape-first because those signals are mechanical and near-zero-FP (a
 * `*.tf` is Terraform, a YAML with `apiVersion:`+`kind:` is a K8s manifest),
 * unlike the recall-favoring AI/ML token detectors.
 *
 * Each finding is tagged `mechanical` (filename/extension or unambiguous
 * structural marker) or `heuristic` (content-sniffed: Ansible, CloudFormation),
 * mirroring the AI/ML cells' tier honesty.
 *
 * Scope (first cut, #168): everything reachable from already-indexed YAML/JSON
 * plus Terraform (`.tf`/`.tfvars`, added to DEFAULT_EXTENSIONS). Extensionless
 * `Dockerfile`/`Jenkinsfile` are NOT yet indexed (would need a core `_walkDir`
 * change — out of this cut's scope, tracked as a #168 follow-up); docker-compose
 * covers the Containers cell and the `.yml` CI configs cover CI/CD meanwhile.
 */

export const INFRA_CELLS = ['Containers', 'Kubernetes', 'IaC', 'Cloud', 'CI/CD'];

/** Normalize a Terraform provider name to a display provider. */
function normProvider(p) {
  const l = p.toLowerCase();
  if (l === 'aws') return 'aws';
  if (l === 'azurerm' || l === 'azure') return 'azure';
  if (l === 'google' || l === 'google-beta') return 'gcp';
  return l;
}

/** Terraform `provider "<x>"` block → normalized provider, or null. */
function terraformProvider(lines) {
  for (const l of lines) {
    const m = /provider\s+"(aws|azurerm|google|google-beta)"/.exec(l) || /\bhashicorp\/(aws|azurerm|google)\b/.exec(l);
    if (m) return normProvider(m[1]);
  }
  return null;
}

/**
 * Cloud-provider usage by high-precision import/marker (#168 flesh-out).
 * Disjoint in practice from the file-shape cells (this fires on application
 * code: boto3/aws-sdk/CDK, azure SDK, google-cloud). First match wins.
 * @returns {{provider,marker,tag,line}|null}
 */
export function detectCloudProvider(relPath, lines = []) {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(import\s+boto3|from\s+boto3\b)/.test(l))
      return { provider: 'aws', marker: 'boto3', tag: 'mechanical', line: i + 1 };
    if (/aws-cdk-lib|@aws-cdk\//.test(l))
      return { provider: 'aws', marker: 'aws-cdk', tag: 'mechanical', line: i + 1 };
    if (/@aws-sdk\/|require\(['"]aws-sdk['"]\)|from\s+['"]aws-sdk['"]/.test(l))
      return { provider: 'aws', marker: 'aws-sdk', tag: 'mechanical', line: i + 1 };
    if (/^\s*(from\s+azure\.|import\s+azure\b)/.test(l) || /@azure\//.test(l))
      return { provider: 'azure', marker: 'azure-sdk', tag: 'mechanical', line: i + 1 };
    if (/^\s*from\s+google\.cloud\b/.test(l) || /@google-cloud\//.test(l))
      return { provider: 'gcp', marker: 'gcp-sdk', tag: 'mechanical', line: i + 1 };
  }
  return null;
}

/** First 1-based line index matching `re`, or 0 if none. */
function firstLineMatching(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 0;
}

/**
 * Classify a single indexed file into an Infrastructure cell, or null.
 * First match wins; ordering is chosen so path/filename-anchored mechanical
 * signals win over content-sniffed heuristics.
 * @returns {{cell,kind,tag,line}|null}
 */
export function classifyInfraFile(relPath, lines = []) {
  const p = String(relPath).replace(/\\/g, '/');
  const lower = p.toLowerCase();
  const base = p.split('/').pop();
  const baseLower = base.toLowerCase();
  const ext = base.includes('.') ? '.' + base.split('.').pop().toLowerCase() : '';
  const isYaml = ext === '.yaml' || ext === '.yml';

  // --- CI/CD (path / filename driven, mechanical) ---
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(lower))
    return { cell: 'CI/CD', kind: 'github-actions', tag: 'mechanical', line: 1 };
  if (baseLower === '.gitlab-ci.yml' || baseLower === '.gitlab-ci.yaml')
    return { cell: 'CI/CD', kind: 'gitlab-ci', tag: 'mechanical', line: 1 };
  if (/(^|\/)\.circleci\/config\.ya?ml$/.test(lower))
    return { cell: 'CI/CD', kind: 'circleci', tag: 'mechanical', line: 1 };
  if (baseLower === 'azure-pipelines.yml' || baseLower === 'azure-pipelines.yaml')
    return { cell: 'CI/CD', kind: 'azure-pipelines', tag: 'mechanical', line: 1 };
  if (baseLower === '.travis.yml')
    return { cell: 'CI/CD', kind: 'travis', tag: 'mechanical', line: 1 };

  // --- Containers (docker-compose; bare Dockerfile deferred — not indexed) ---
  if (/^(docker-compose|compose)\.ya?ml$/.test(baseLower))
    return { cell: 'Containers', kind: 'docker-compose', tag: 'mechanical', line: 1 };

  // --- IaC: Terraform / Pulumi (mechanical) ---
  if (ext === '.tf' || ext === '.tfvars')
    return { cell: 'IaC', kind: 'terraform', tag: 'mechanical', line: 1 };
  if (baseLower === 'pulumi.yaml' || baseLower === 'pulumi.yml')
    return { cell: 'IaC', kind: 'pulumi', tag: 'mechanical', line: 1 };
  if (ext === '.bicep')   // Azure Bicep (mechanical — its own extension)
    return { cell: 'IaC', kind: 'bicep', tag: 'mechanical', line: 1 };

  // --- IaC: CloudFormation (AWS) / ARM (Azure) — content-sniffed in yaml/json ---
  if (isYaml || ext === '.json') {
    const cfn = firstLineMatching(lines, /AWSTemplateFormatVersion|["']?Type["']?\s*:\s*["']?AWS::/);
    if (cfn) return { cell: 'IaC', kind: 'cloudformation', tag: 'heuristic', line: cfn };
    // ARM: Azure deployment-template schema, or a Microsoft.* resource type.
    const arm = firstLineMatching(lines, /schema\.management\.azure\.com|["']type["']\s*:\s*["']Microsoft\.[A-Za-z]+\//);
    if (arm) return { cell: 'IaC', kind: 'arm', tag: 'heuristic', line: arm };
  }

  // --- Kubernetes (apiVersion + kind, mechanical) / Helm ---
  if (isYaml) {
    const av = firstLineMatching(lines, /^\s*apiVersion\s*:/);
    const kd = firstLineMatching(lines, /^\s*kind\s*:/);
    if (av && kd) return { cell: 'Kubernetes', kind: 'k8s-manifest', tag: 'mechanical', line: av };
    if (baseLower === 'chart.yaml') return { cell: 'Kubernetes', kind: 'helm-chart', tag: 'mechanical', line: 1 };
  }

  // --- IaC: Ansible playbook (heuristic — hosts + tasks shape) ---
  if (isYaml) {
    const hosts = firstLineMatching(lines, /^\s*-?\s*hosts\s*:/);
    const tasks = firstLineMatching(lines, /^\s*tasks\s*:/);
    if (hosts && tasks) return { cell: 'IaC', kind: 'ansible', tag: 'heuristic', line: hosts };
  }

  return null;
}

/**
 * Scan an index's files and return Infrastructure findings.
 * @returns {{rows: Array<{cell,kind,tag,line,filepath,name}>, filesScanned: number}}
 */
export function detectInfrastructure(index) {
  const rows = [];
  let filesScanned = 0;
  for (const [filepath, lines] of index.fileLines) {
    filesScanned++;
    const ls = lines || [];
    // Skip vendored/dependency trees — their infra/cloud usage isn't the
    // project's own (e.g. node_modules/aws-sdk/README.md is not "this codebase
    // uses AWS"). Keeps the accordion about the indexed project, not its deps.
    if (/(^|\/)(node_modules|site-packages|vendor|bower_components|\.venv|dist|build)\//.test(String(filepath).replace(/\\/g, '/'))) continue;
    const name = String(filepath).replace(/\\/g, '/').split('/').pop();
    const hit = classifyInfraFile(filepath, ls);
    if (hit) {
      // Provider-tag IaC findings so the cloud shows in the kind (#168 flesh-out):
      // terraform via its provider block, CloudFormation is inherently AWS.
      if (hit.kind === 'terraform') {
        const prov = terraformProvider(ls);
        if (prov) hit.kind = `terraform/${prov}`;
      } else if (hit.kind === 'cloudformation') {
        hit.kind = 'cloudformation/aws';   // CloudFormation is inherently AWS
      } else if (hit.kind === 'arm' || hit.kind === 'bicep') {
        hit.kind = `${hit.kind}/azure`;    // ARM / Bicep are inherently Azure
      }
      rows.push({ ...hit, filepath, name });
      continue;
    }
    // Not a file-shape artifact — check for cloud-SDK usage in code (Cloud cell).
    const cloud = detectCloudProvider(filepath, ls);
    if (cloud) {
      rows.push({ cell: 'Cloud', kind: cloud.provider, marker: cloud.marker, tag: cloud.tag, line: cloud.line, filepath, name });
    }
  }
  return { rows, filesScanned };
}
