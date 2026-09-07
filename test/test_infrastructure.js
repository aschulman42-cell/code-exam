// test_infrastructure.js — #168 infra detector: Containers/K8s/IaC/CI-CD file shapes, plus FP guards
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Coverage for the Infrastructure detector (#168) — file-shape classification
// for Containers / Kubernetes / IaC / CI-CD. The detector is mechanical-first,
// so these assertions pin both the positive shapes and the no-false-positive
// guards (generic YAML, source files, bare Dockerfile-deferred).
import { test } from 'node:test';
import assert from 'node:assert';
import { classifyInfraFile, detectInfrastructure, detectCloudProvider } from '../src/core/stack-detectors.js';

const cell = (p, lines = []) => { const h = classifyInfraFile(p, lines); return h && h.cell; };
const kind = (p, lines = []) => { const h = classifyInfraFile(p, lines); return h && h.kind; };
const pick = (h) => h && { provider: h.provider, marker: h.marker };

test('CI/CD: GitHub Actions / GitLab / CircleCI by path/filename', () => {
  assert.equal(kind('.github/workflows/ci.yml', ['on: push']), 'github-actions');
  assert.equal(kind('repo/.github/workflows/release.yaml', []), 'github-actions');
  assert.equal(kind('.gitlab-ci.yml', []), 'gitlab-ci');
  assert.equal(kind('.circleci/config.yml', []), 'circleci');
});

test('Containers: docker-compose (bare Dockerfile is deferred — not indexed)', () => {
  assert.equal(kind('docker-compose.yml', []), 'docker-compose');
  assert.equal(kind('deploy/compose.yaml', []), 'docker-compose');
  // bare Dockerfile is intentionally NOT classified yet (#168 follow-up: needs
  // a core indexer change to index extensionless files).
  assert.equal(classifyInfraFile('Dockerfile', []), null);
});

test('IaC: Terraform / Pulumi (mechanical), CloudFormation / Ansible (heuristic)', () => {
  assert.equal(kind('infra/main.tf', []), 'terraform');
  assert.equal(kind('vars.tfvars', []), 'terraform');
  assert.equal(kind('Pulumi.yaml', []), 'pulumi');
  const cfn = classifyInfraFile('stack.yaml', ['AWSTemplateFormatVersion: "2010-09-09"', 'Resources:']);
  assert.equal(cfn.kind, 'cloudformation');
  assert.equal(cfn.tag, 'heuristic');
  const ans = classifyInfraFile('playbook.yml', ['- hosts: web', '  tasks:', '    - name: install']);
  assert.equal(ans.kind, 'ansible');
  assert.equal(ans.tag, 'heuristic');
});

test('IaC: ARM (Azure) and Bicep detection (#168 flesh-out)', () => {
  const armSchema = classifyInfraFile('azuredeploy.json', ['{', '  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",']);
  assert.equal(armSchema.kind, 'arm');
  const armType = classifyInfraFile('template.json', ['{', '  "resources": [{ "type": "Microsoft.Storage/storageAccounts" }]']);
  assert.equal(armType.kind, 'arm');
  assert.equal(kind('main.bicep', []), 'bicep');
  // ARM/CFN/Bicep get provider-tagged in detectInfrastructure
  const index = { fileLines: new Map([
    ['azuredeploy.json', ['"$schema": "https://schema.management.azure.com/x/deploymentTemplate.json#"']],
    ['infra.bicep', ['resource sa ...']],
    ['cfn.yaml', ['AWSTemplateFormatVersion: "2010-09-09"']],
  ]) };
  const byFile = Object.fromEntries(detectInfrastructure(index).rows.map(r => [r.name, r.kind]));
  assert.equal(byFile['azuredeploy.json'], 'arm/azure');
  assert.equal(byFile['infra.bicep'], 'bicep/azure');
  assert.equal(byFile['cfn.yaml'], 'cloudformation/aws');
});

test('Kubernetes: apiVersion + kind required (mechanical); Helm Chart.yaml', () => {
  const k = classifyInfraFile('k8s/deploy.yaml', ['apiVersion: apps/v1', 'kind: Deployment']);
  assert.equal(k.cell, 'Kubernetes');
  assert.equal(k.kind, 'k8s-manifest');
  assert.equal(k.tag, 'mechanical');
  assert.equal(k.line, 1);
  assert.equal(kind('charts/app/Chart.yaml', ['name: app']), 'helm-chart');
});

test('no false positives: generic YAML, JSON, and source files', () => {
  assert.equal(classifyInfraFile('config.yaml', ['name: thing', 'value: 3']), null); // no apiVersion+kind
  assert.equal(classifyInfraFile('package.json', ['{', '  "name": "x"', '}']), null);
  assert.equal(classifyInfraFile('src/app.py', ['import os']), null);
  assert.equal(classifyInfraFile('README.md', ['# Title']), null);
});

test('Cloud (#168 flesh-out): SDK imports → provider, high precision', () => {
  assert.deepEqual(pick(detectCloudProvider('app.py', ['import boto3'])), { provider: 'aws', marker: 'boto3' });
  assert.deepEqual(pick(detectCloudProvider('s.ts', ["import { S3 } from '@aws-sdk/client-s3'"])), { provider: 'aws', marker: 'aws-sdk' });
  assert.deepEqual(pick(detectCloudProvider('cdk.ts', ["import * as cdk from 'aws-cdk-lib'"])), { provider: 'aws', marker: 'aws-cdk' });
  assert.deepEqual(pick(detectCloudProvider('a.py', ['from azure.storage.blob import BlobClient'])), { provider: 'azure', marker: 'azure-sdk' });
  assert.deepEqual(pick(detectCloudProvider('g.py', ['from google.cloud import storage'])), { provider: 'gcp', marker: 'gcp-sdk' });
  // no false positive on prose / unrelated identifiers
  assert.equal(detectCloudProvider('readme.md', ['We deploy to AWS and Azure.']), null);
  assert.equal(detectCloudProvider('x.py', ['azure = 3  # a variable']), null);
});

test('Terraform provider tagging surfaces the cloud (#168 flesh-out)', () => {
  const index = { fileLines: new Map([
    ['infra/main.tf', ['provider "aws" {', '  region = "us-east-1"', '}']],
    ['infra/az.tf', ['provider "azurerm" {}']],
    ['app.py', ['import boto3']],
  ]) };
  const { rows } = detectInfrastructure(index);
  const byFile = Object.fromEntries(rows.map(r => [r.name, `${r.cell}:${r.kind}`]));
  assert.equal(byFile['main.tf'], 'IaC:terraform/aws');
  assert.equal(byFile['az.tf'], 'IaC:terraform/azure');
  assert.equal(byFile['app.py'], 'Cloud:aws');   // boto3 in code → Cloud cell
});

test('detectInfrastructure groups findings over an index.fileLines map', () => {
  const index = { fileLines: new Map([
    ['.github/workflows/ci.yml', ['on: push']],
    ['infra/main.tf', ['resource "aws_s3_bucket" "b" {}']],
    ['k8s/deploy.yaml', ['apiVersion: apps/v1', 'kind: Deployment']],
    ['src/app.py', ['import os']],
    ['docker-compose.yml', ['services:']],
  ]) };
  const { rows, filesScanned } = detectInfrastructure(index);
  assert.equal(filesScanned, 5);
  assert.equal(rows.length, 4);                       // py file excluded
  const cells = new Set(rows.map(r => r.cell));
  assert.ok(cells.has('CI/CD') && cells.has('IaC') && cells.has('Kubernetes') && cells.has('Containers'));
  assert.ok(rows.every(r => r.filepath && r.name && r.line >= 1));
});
