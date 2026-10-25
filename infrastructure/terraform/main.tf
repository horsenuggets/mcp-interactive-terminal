terraform {
  required_version = ">= 1.5"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

provider "github" {
  owner = "HorseNuggets"
  # Authenticates via GITHUB_TOKEN environment variable
}

locals {
  repo_name = "mcp-interactive-terminal"

  required_checks = [
    "Build & Test",
  ]
}

# Repository settings
resource "github_repository" "repo" {
  name        = local.repo_name
  description = "MCP server that gives AI agents (Claude Code, Cursor, Windsurf) real interactive terminal sessions — REPLs, SSH, databases, Docker, and any interactive CLI with clean output and smart completion detection."
  visibility  = "public"

  has_issues   = true
  has_projects = false
  has_wiki     = false

  allow_squash_merge = true
  allow_merge_commit = false
  allow_rebase_merge = false

  delete_branch_on_merge = true

  squash_merge_commit_title   = "PR_TITLE"
  squash_merge_commit_message = "PR_BODY"
}

# Branch protection for main
resource "github_repository_ruleset" "main" {
  name        = "main"
  repository  = github_repository.repo.name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  rules {
    pull_request {
      required_approving_review_count = 1
      dismiss_stale_reviews_on_push   = true
    }

    copilot_code_review {
      review_on_push             = true
      review_draft_pull_requests = false
    }

    required_status_checks {
      dynamic "required_check" {
        for_each = local.required_checks
        content {
          context        = required_check.value
          integration_id = 15368
        }
      }
    }
  }
}

# Keeps Copilot code review at the Lite effort level, which costs several times fewer AI
# credits than the Balanced default, and corrects drift on apply.
module "copilot_review" {
  source        = "git::https://github.com/horsenuggets/luau-cicd.git//Terraform/Modules/CopilotReview?ref=a4ef277d84e90bc299d843ed79704c98234cd448"
  repository    = "horsenuggets/${local.repo_name}"
  review_effort = "lite"
}
