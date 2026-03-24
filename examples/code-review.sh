#!/bin/bash
# Example: Ask aicli to review a pull request diff

git diff main..feature/my-branch | aicli run "Review this diff and suggest improvements"
