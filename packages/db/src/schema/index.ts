import { defineRelations } from "drizzle-orm";

import { organization, team, user } from "../auth-schema";
import { project, projectJob, projectNode, projectTag, tag } from "./projects";
import {
  projectCollaborator,
  projectShareGrant,
  projectShareLink,
  projectTeam,
} from "./sharing";

export * from "../auth-schema";
export * from "./ai";
export * from "./comments";
export * from "./projects";
export * from "./sharing";

export const relations = defineRelations(
  {
    project,
    projectCollaborator,
    projectJob,
    projectNode,
    projectShareGrant,
    projectShareLink,
    projectTeam,
    team,
    projectTag,
    tag,
    organization,
    user,
  },
  (r) => ({
    project: {
      collaborators: r.many.projectCollaborator(),
      shareGrants: r.many.projectShareGrant(),
      teams: r.many.projectTeam(),
      jobs: r.many.projectJob(),
      nodes: r.many.projectNode(),
      owner: r.one.user({
        from: r.project.ownerId,
        to: r.user.id,
      }),
      // Members come from authRelations once the parts merge in createDb.
      organization: r.one.organization({
        from: r.project.organizationId,
        to: r.organization.id,
      }),
      // Every user's labels; filter by tag.userId when reading.
      tags: r.many.tag({
        from: r.project.id.through(r.projectTag.projectId),
        to: r.tag.id.through(r.projectTag.tagId),
      }),
    },
    projectCollaborator: {
      project: r.one.project({
        from: r.projectCollaborator.projectId,
        to: r.project.id,
      }),
      user: r.one.user({
        from: r.projectCollaborator.userId,
        to: r.user.id,
      }),
    },
    projectJob: {
      project: r.one.project({
        from: r.projectJob.projectId,
        to: r.project.id,
      }),
    },
    projectShareLink: {
      project: r.one.project({
        from: r.projectShareLink.projectId,
        to: r.project.id,
      }),
    },
    projectShareGrant: {
      link: r.one.projectShareLink({
        from: r.projectShareGrant.linkId,
        to: r.projectShareLink.id,
      }),
      project: r.one.project({
        from: r.projectShareGrant.projectId,
        to: r.project.id,
      }),
    },
    projectTeam: {
      project: r.one.project({
        from: r.projectTeam.projectId,
        to: r.project.id,
      }),
      team: r.one.team({
        from: r.projectTeam.teamId,
        to: r.team.id,
      }),
    },
    projectNode: {
      children: r.many.projectNode({
        from: r.projectNode.id,
        to: r.projectNode.parentId,
      }),
      parent: r.one.projectNode({
        from: r.projectNode.parentId,
        to: r.projectNode.id,
      }),
      project: r.one.project({
        from: r.projectNode.projectId,
        to: r.project.id,
      }),
    },
    user: {
      ownedProjects: r.many.project({
        from: r.user.id,
        to: r.project.ownerId,
      }),
      projectCollaborations: r.many.projectCollaborator({
        from: r.user.id,
        to: r.projectCollaborator.userId,
      }),
    },
  }),
);
