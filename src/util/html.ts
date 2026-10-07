import type { User } from "grammy/types";
import type { UserInfo } from "../store.js";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function displayName(user: Pick<User, "first_name" | "last_name"> | UserInfo): string {
  if ("firstName" in user) return user.firstName;
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

/** 產生會通知對方的 HTML mention；有 username 就用 @，否則用 tg://user 連結 */
export function mentionHtml(user: User | UserInfo): string {
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.id}">${escapeHtml(displayName(user))}</a>`;
}

export function toUserInfo(user: User): Omit<UserInfo, "lastSeen"> {
  return { id: user.id, username: user.username, firstName: displayName(user) };
}
