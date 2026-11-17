<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, json } from '../api'
import type { Role, User } from '../contracts'
import AppIcon from './AppIcon.vue'
const emit = defineEmits<{ close: []; changed: [user: User] }>()
const accounts = ref<User[]>([])
const busy = ref(false)
const error = ref('')
const roles: { value: Role; label: string }[] = [{ value: 'admin', label: '管理员' }, { value: 'editor', label: '编辑者' }, { value: 'viewer', label: '查看者' }]
const form = ref({ username: '', displayName: '', password: '', role: 'viewer' as Role })
async function act(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await action() } catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败' }
  finally { busy.value = false }
}
async function changeRole(account: User, event: Event) {
  const select = event.target as HTMLSelectElement
  const role = select.value as Role
  select.value = account.role
  if (role === account.role) return
  if (!window.confirm(`将「${account.displayName}」修改为${roles.find(item => item.value === role)?.label}？降低权限会撤销该账号的登录会话。`)) return
  await act(async () => {
    const changed = await api<User>(`/users/${account.id}`, { method: 'PATCH', body: json({ role }) })
    accounts.value = accounts.value.map(item => item.id === changed.id ? changed : item)
    emit('changed', changed)
  })
}
async function create() {
  await act(async () => {
    accounts.value.push(await api<User>('/users', { method: 'POST', body: json(form.value) }))
    form.value = { username: '', displayName: '', password: '', role: 'viewer' }
  })
}
onMounted(() => { void act(async () => { accounts.value = await api<User[]>('/users') }) })
</script>
<template>
  <div class="modal-overlay" @click.self="!busy && emit('close')"><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="account-title">
    <header class="modal-header"><h2 id="account-title">团队账号与全局角色</h2><button class="icon-button" :disabled="busy" aria-label="关闭" @click="emit('close')"><AppIcon name="close" /></button></header>
    <p v-if="error" class="error-box" role="alert">{{ error }}</p>
    <div class="account-list"><article v-for="account in accounts" :key="account.id" class="account-row"><span class="avatar">{{ account.displayName.slice(0, 1) }}</span><div><strong>{{ account.displayName }}</strong><small>{{ account.username }}</small></div><select :value="account.role" :disabled="busy" :aria-label="`${account.displayName}的角色`" @change="changeRole(account, $event)"><option v-for="role in roles" :key="role.value" :value="role.value">{{ role.label }}</option></select></article></div>
    <form class="stack-form section-divider" @submit.prevent="create"><h3>创建账号</h3><div class="form-columns"><label>用户名<input v-model="form.username" required pattern="[A-Za-z0-9_-]{3,40}" minlength="3" maxlength="40" autocomplete="off" :disabled="busy"></label><label>显示名称<input v-model="form.displayName" required maxlength="80" :disabled="busy"></label></div><label>初始密码<input v-model="form.password" type="password" required minlength="6" maxlength="200" autocomplete="new-password" :disabled="busy"></label><label>全局角色<select v-model="form.role" :disabled="busy"><option v-for="role in roles" :key="role.value" :value="role.value">{{ role.label }}</option></select></label><footer class="modal-footer"><button class="primary" :disabled="busy">创建账号</button></footer></form>
  </section></div>
</template>
