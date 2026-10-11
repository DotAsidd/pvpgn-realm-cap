--[[
	Copyright (C) 2014 HarpyWar (harpywar@gmail.com)
	
	This file is a part of the PvPGN Project http://pvpgn.pro
	Licensed under the same terms as Lua itself.
]]--


-- Loop each second
function handle_server_mainloop()
	-- Tick all timers
	for t in pairs(__timers) do
		__timers[t]:tick()
	end

	-- Realm Chat Bridge: Process outgoing messages from Web / QML to Battle.net channel
	local pipe_path = "/var/pvpgn/web_to_bnet.pipe"
	local f = io.open(pipe_path, "r")
	if f then
		local lines = {}
		for line in f:lines() do
			if line and #line > 0 then
				table.insert(lines, line)
			end
		end
		f:close()
		os.remove(pipe_path)

		for _, line in ipairs(lines) do
			local tab_pos = string.find(line, "\t")
			if tab_pos then
				local prefix = string.sub(line, 1, tab_pos - 1)
				local rest = string.sub(line, tab_pos + 1)

				if prefix == "__MUTE__" then
					-- Format: __MUTE__ \t target_username \t reason \t minutes
					local p1 = string.find(rest, "\t")
					if p1 then
						local target_user = string.sub(rest, 1, p1 - 1)
						local rest2 = string.sub(rest, p1 + 1)
						local p2 = string.find(rest2, "\t")
						local reason = p2 and string.sub(rest2, 1, p2 - 1) or rest2
						local mins = p2 and tonumber(string.sub(rest2, p2 + 1)) or 0

						account_set_auth_mute(target_user, true)
						account_set_auth_mutereason(target_user, reason)
						account_set_auth_muteby(target_user, "Admin")
						if mins and mins > 0 then
							account_set_auth_mutetime(target_user, os.time() + (mins * 60))
						else
							account_set_auth_mutetime(target_user, 0)
						end

						-- Send fallback notification immediately on screen
						api.message_send_text(target_user, message_type_error, nil, "[MUTED] Your account has been muted by Admin. Reason: " .. reason)
						api.message_send_text(target_user, message_type_whisper, "Admin", "[MUTED] Your account has been muted. Reason: " .. reason)
					end
				elseif prefix == "__LOCK__" then
					-- Format: __LOCK__ \t target_username \t reason
					local p1 = string.find(rest, "\t")
					local target_user = p1 and string.sub(rest, 1, p1 - 1) or rest
					local reason = p1 and string.sub(rest, p1 + 1) or "Account locked by administrator"
					target_user = target_user:match("^%s*(.-)%s*$")

					if target_user:lower() ~= "sidd" then
						local r1 = account_set_auth_lock(target_user, true)
						local r2 = account_set_auth_lockreason(target_user, reason)
						account_set_auth_lockby(target_user, "Admin")
						local cur_lock = account_get_auth_lock(target_user)
						local f_log = io.open("/var/pvpgn/pipe_debug.log", "a")
						if f_log then
							f_log:write(string.format("%s [LOCK] user=%s set_res=%s cur_lock=%s\n", os.date(), target_user, tostring(r1), tostring(cur_lock)))
							f_log:close()
						end
						-- Send notification to user
						api.message_send_text(target_user, message_type_error, nil, "[BANNED] Your account has been locked: " .. reason)
						api.message_send_text(target_user, message_type_whisper, "Admin", "[BANNED] Your account has been locked: " .. reason)

						-- Terminate active session immediately
						api.client_kill(target_user)
					end
				elseif prefix == "__UNLOCK__" then
					local target_user = rest:match("^%s*(.-)%s*$")
					local r1 = account_set_auth_lock(target_user, false)
					local r2 = account_set_auth_locktime(target_user, 0)
					local r3 = account_set_auth_lockreason(target_user, "")
					local cur_lock = account_get_auth_lock(target_user)
					local f_log = io.open("/var/pvpgn/pipe_debug.log", "a")
					if f_log then
						f_log:write(string.format("%s [UNLOCK] user=%s set_res=%s cur_lock=%s\n", os.date(), target_user, tostring(r1), tostring(cur_lock)))
						f_log:close()
					end
					api.message_send_text(target_user, message_type_info, nil, "[UNLOCKED] Your account has been unlocked.")
				elseif prefix == "__KICK__" then
					-- Format: __KICK__ \t target_username \t reason
					local p1 = string.find(rest, "\t")
					local target_user = p1 and string.sub(rest, 1, p1 - 1) or rest
					local reason = p1 and string.sub(rest, p1 + 1) or "Kicked by administrator"
					target_user = target_user:match("^%s*(.-)%s*$")

					if target_user:lower() ~= "sidd" then
						api.message_send_text(target_user, message_type_error, nil, "[KICKED] " .. reason)
						api.client_kill(target_user)
					end
				elseif prefix == "__IPBAN__" then
					-- Format: __IPBAN__ \t ip \t reason
					local p1 = string.find(rest, "\t")
					local target_ip = p1 and string.sub(rest, 1, p1 - 1) or rest
					local reason = p1 and string.sub(rest, p1 + 1) or "IP banned by administrator"
					target_ip = target_ip:match("^%s*(.-)%s*$")

					-- Append to banfile if not already present
					local f_ban = io.open("/etc/pvpgn/bnban.conf", "a")
					if f_ban then
						f_ban:write(target_ip .. "\n")
						f_ban:close()
					end

					-- Terminate all active sessions connected from this IP & lock account
					for i, account in pairs(api.server_get_users()) do
						if account and account.name then
							local user_ip = account.ip or account.address or ""
							if user_ip == target_ip or (string.len(target_ip) >= 4 and string.find(user_ip, "^" .. string.gsub(target_ip, "%.", "%%."))) then
								if account.name:lower() ~= "sidd" then
									account_set_auth_lock(account.name, true)
									account_set_auth_lockreason(account.name, reason)
									account_set_auth_lockby(account.name, "Admin")
									api.message_send_text(account.name, message_type_error, nil, "[IP BANNED] " .. reason)
									api.client_kill(account.name)
								end
							end
						end
					end
				elseif prefix == "__UNMUTE__" then
					local target_user = rest
					account_set_auth_mute(target_user, false)
					account_set_auth_mutetime(target_user, 0)
					account_set_auth_mutereason(target_user, "")
					api.message_send_text(target_user, message_type_info, nil, "[UNMUTED] Your chat privileges have been restored.")
					api.message_send_text(target_user, message_type_whisper, "Admin", "[UNMUTED] Your chat privileges have been restored.")
				else
					local sender = prefix
					local msg = rest
					local formatted = "[Main] <" .. sender .. "> " .. msg

					-- Log for verification
					local dbg = io.open("/var/pvpgn/bridge_debug.log", "a")
					if dbg then
						dbg:write(os.date() .. " [Web->MainChat] " .. formatted .. "\n")
					end

					-- Deliver to Main Chat for all connected users
					for i, account in pairs(api.server_get_users()) do
						if account and account.name then
							if dbg then
								dbg:write("  sending to: " .. account.name .. " (game_id=" .. tostring(account.game_id) .. ")\n")
							end

							-- Deliver to Main Chat (info event on Battle.net channel)
							api.message_send_text(account.name, message_type_info, nil, formatted)

							-- If player is in lobby or match, whisper so they see Main Chat without disturbing Lobby Chat
							if account.game_id and account.game_id > 0 then
								api.message_send_text(account.name, message_type_whisper, "MainChat", formatted)
							end
						end
					end

					if dbg then dbg:close() end
				end
			end
		end
	end
end


-- When restart Lua VM
function handle_server_rehash()
	if (config.ghost) then
		gh_unload()
	end

end