import type { Db } from "@texfolia/db";
import {
  account,
  aiSettings,
  member,
  organization,
  project,
  projectComment,
  session,
  tag,
  template,
  user,
} from "@texfolia/db/schema";
import { desc, eq } from "drizzle-orm";

/**
 * Collects a user's personal and account data for GDPR portability export.
 * Explicitly omits credentials, OAuth tokens, and session tokens.
 */
export async function exportAccountData(db: Db, userId: string) {
  const [
    [profile],
    connectedAccounts,
    sessions,
    organizations,
    [ai],
    projects,
    tags,
    comments,
    templates,
  ] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })
      .from(user)
      .where(eq(user.id, userId)),
    db
      .select({
        id: account.id,
        providerId: account.providerId,
        accountId: account.accountId,
        scope: account.scope,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })
      .from(account)
      .where(eq(account.userId, userId))
      .orderBy(account.createdAt),
    db
      .select({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })
      .from(session)
      .where(eq(session.userId, userId))
      .orderBy(desc(session.createdAt)),
    db
      .select({
        organizationId: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, userId))
      .orderBy(member.createdAt),
    db
      .select({
        defaultModel: aiSettings.defaultModel,
        monthlyCapNanos: aiSettings.monthlyCapNanos,
      })
      .from(aiSettings)
      .where(eq(aiSettings.userId, userId)),
    db
      .select({
        id: project.id,
        name: project.name,
        mainFile: project.mainFile,
        formatIndent: project.formatIndent,
        formatWrap: project.formatWrap,
        formatWidth: project.formatWidth,
        spellcheckLanguage: project.spellcheckLanguage,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        deletedAt: project.deletedAt,
      })
      .from(project)
      .where(eq(project.ownerId, userId))
      .orderBy(desc(project.updatedAt)),
    db
      .select({
        id: tag.id,
        name: tag.name,
      })
      .from(tag)
      .where(eq(tag.userId, userId))
      .orderBy(tag.name),
    db
      .select({
        id: projectComment.id,
        threadId: projectComment.threadId,
        body: projectComment.body,
        createdAt: projectComment.createdAt,
        editedAt: projectComment.editedAt,
      })
      .from(projectComment)
      .where(eq(projectComment.authorId, userId))
      .orderBy(desc(projectComment.createdAt)),
    db
      .select({
        id: template.id,
        title: template.title,
        description: template.description,
        tags: template.tags,
        license: template.license,
        visibility: template.visibility,
        status: template.status,
        mainFile: template.mainFile,
        rejectionReason: template.rejectionReason,
        unpublishedAt: template.unpublishedAt,
        createdAt: template.createdAt,
      })
      .from(template)
      .where(eq(template.ownerId, userId))
      .orderBy(desc(template.createdAt)),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    profile: profile ?? null,
    connectedAccounts,
    sessions,
    organizations,
    aiSettings: ai ?? null,
    projects,
    tags,
    comments,
    templates,
  };
}
