--[[
	Copyright (C) 2014 HarpyWar (harpywar@gmail.com)
	
	This file is a part of the PvPGN Project http://pvpgn.pro
	Licensed under the same terms as Lua itself.
]]--


function handle_user_whisper(account_src, account_dst, text)
	--DEBUG(account_src.name.."->"..account_dst.name.. ": ".. text)
	--return 1;
end

function handle_user_login(account)
	if (config.ghost) then
		gh_handle_user_login(account)
	end
	
	if account and account.name then
		local u_name = account.name
		local u_ip = account.ip or account.address or ""
		
		-- Root administrator immunity
		if u_name:lower() ~= "sidd" then
			-- 1. In-memory auth_lock check
			local is_locked = account_get_auth_lock(u_name)
			if is_locked == true or is_locked == 1 then
				local lock_time = tonumber(account_get_auth_locktime(u_name) or 0) or 0
				if lock_time > 0 and os.time() >= lock_time then
					-- Ban expired! Auto-unlock
					account_set_auth_lock(u_name, false)
					account_set_auth_locktime(u_name, 0)
					account_set_auth_lockreason(u_name, "")
				else
					local lock_reason = account_get_auth_lockreason(u_name)
					if not lock_reason or lock_reason == "" then
						lock_reason = "Account locked by administrator"
					end
					if lock_time > 0 then
						local remaining_mins = math.ceil((lock_time - os.time()) / 60)
						if remaining_mins > 60 then
							local remaining_hrs = math.ceil(remaining_mins / 60)
							lock_reason = lock_reason .. string.format(" (Expires in %d hours)", remaining_hrs)
						else
							lock_reason = lock_reason .. string.format(" (Expires in %d mins)", remaining_mins)
						end
					end
					api.message_send_text(u_name, message_type_error, nil, "[LOCKED] " .. lock_reason)
					api.client_kill(u_name)
					return
				end
			end

			-- 2. Database lock sync check via locked_accounts.txt
			local f_locked = io.open("/var/pvpgn/locked_accounts.txt", "r")
			if f_locked then
				local in_db_locked = false
				for line in f_locked:lines() do
					local l_name = line:match("^%s*(.-)%s*$")
					if l_name and l_name ~= "" and l_name:lower() == u_name:lower() then
						in_db_locked = true
						break
					end
				end
				f_locked:close()

				if in_db_locked then
					account_set_auth_lock(u_name, true)
					api.message_send_text(u_name, message_type_error, nil, "[LOCKED] This account is locked in database.")
					api.client_kill(u_name)
					return
				end
			end

			-- 2. IP ban check via bnban.conf
			if u_ip and u_ip ~= "" then
				local f_ban = io.open("/etc/pvpgn/bnban.conf", "r")
				if f_ban then
					local is_banned = false
					for line in f_ban:lines() do
						local b_ip = line:match("^%s*([%d%.]+)")
						if b_ip and b_ip ~= "" then
							if u_ip == b_ip or string.find(u_ip, "^" .. string.gsub(b_ip, "%.", "%%.")) then
								is_banned = true
								break
							end
						end
					end
					f_ban:close()

					if is_banned then
						api.message_send_text(u_name, message_type_error, nil, "[IP BANNED] Your network has been banned.")
						api.client_kill(u_name)
						return
					end
				end
			end
		end

		-- Emit login event for Web tracking, MySQL recording and DB-level anti-VPN verification
		local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
		if f then
			f:write(string.format("__LOGIN__\t%s\t%s\n", u_name, u_ip))
			f:close()
		end
	end
end

function handle_user_disconnect(account)
	if account and account.name then
		local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
		if f then
			f:write(string.format("__PRESENCE__\t%s\tOFFLINE\t\n", account.name))
			f:close()
		end
	end
end

function handle_user_icon(account, iconinfo)
	--TRACE("iconinfo"..iconinfo)
	--return iconinfo
end

