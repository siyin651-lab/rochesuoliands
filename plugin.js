// ============================================================
// 角色图片代发器 v1.0
// 以角色身份插入图片消息（用于锁脸）
// ============================================================

window.RochePlugin.register({
  id: "role-image-sender",
  name: "角色图片代发",
  version: "1.0.0",
  apps: [
    {
      id: "role-image-sender-home",
      name: "图片代发",
      icon: "image",
      iconImage: "",
      async mount(container, roche) {
        // ---------- 状态 ----------
        const state = {
          characters: [],
          selectedCharId: "",
          imageDataUrl: null,      // 最终使用的 dataURL
          imageSource: "",         // 描述来源
          loading: false,
          message: "",
          messageType: "info",
          historyImages: [],       // 从聊天历史获取的图片列表
          showHistoryPicker: false,
        };

        // ---------- 工具 ----------
        function genId() {
          return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        }

        function fileToDataUrl(blob) {
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("读取文件失败"));
            reader.readAsDataURL(blob);
          });
        }

        function fetchUrlAsDataUrl(url) {
          return fetch(url, { mode: "cors", credentials: "omit" })
            .then(resp => {
              if (!resp.ok) throw new Error("HTTP " + resp.status);
              return resp.blob();
            })
            .then(blob => fileToDataUrl(blob))
            .catch(err => {
              throw new Error("无法加载该URL（CORS/权限）：" + err.message);
            });
        }

        function compressImage(dataUrl, maxDim = 1024) {
          return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              const w = img.naturalWidth;
              const h = img.naturalHeight;
              const scale = Math.min(1, maxDim / Math.max(w, h));
              const tw = Math.max(1, Math.round(w * scale));
              const th = Math.max(1, Math.round(h * scale));
              const canvas = document.createElement("canvas");
              canvas.width = tw;
              canvas.height = th;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(img, 0, 0, tw, th);
              resolve(canvas.toDataURL("image/jpeg", 0.9));
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
          });
        }

        // ---------- 核心：以角色身份插入图片消息（直接写 IndexedDB） ----------
        async function injectImageAsCharacter(charId, charName, convId, dataUrl) {
          // 打开 Roche 主数据库
          const DB_NAME = "Roche_db";
          const DB_VERSION = 78;  // 根据实际情况，通常不变
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(new Error("打开数据库失败"));
            req.onupgradeneeded = () => {}; // 不需要升级
          });

          const msgId = "msg_" + genId();
          const now = Date.now();
          const msg = {
            id: msgId,
            conversationId: convId,
            text: dataUrl,
            senderId: charId,
            senderName: charName || charId,
            isMe: false,
            senderIsMe: false,
            type: "image",
            image: dataUrl,
            img: dataUrl,
            data: dataUrl,
            url: dataUrl,
            mediaUrl: dataUrl,
            src: dataUrl,
            content: dataUrl,
            timestamp: now,
            createdAt: now,
            time: now,
            personalityState: "normal",
            sendFailed: false,
            status: "sent",
            width: 0,
            height: 0,
            mimeType: "image/jpeg",
            format: "jpeg",
          };

          const tx = db.transaction("messages", "readwrite");
          const store = tx.objectStore("messages");
          await new Promise((resolve, reject) => {
            const req = store.add(msg);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });
          db.close();
          return { msgId, convId };
        }

        // ---------- 获取角色和聊天历史 ----------
        async function loadCharacters() {
          try {
            const chars = await roche.character.list();
            state.characters = chars || [];
            if (!state.selectedCharId && state.characters.length > 0) {
              state.selectedCharId = state.characters[0].id;
            }
          } catch (e) {
            showMessage("加载角色失败：" + e.message, "error");
          }
        }

        async function loadHistoryImages() {
          // 使用 roche.memory.getShortTerm 获取最近消息，过滤图片
          if (!state.selectedCharId) {
            showMessage("请先选择角色", "error");
            return;
          }
          // 先获取角色的 conversationId
          let convId;
          try {
            const char = await roche.character.get(state.selectedCharId);
            convId = char.conversationId;
            if (!convId) {
              showMessage("该角色没有关联会话，无法获取历史图片", "error");
              return;
            }
          } catch (e) {
            showMessage("获取角色信息失败：" + e.message, "error");
            return;
          }

          try {
            const messages = await roche.memory.getShortTerm({
              conversationId: convId,
              limit: 200,
            });
            const images = messages
              .filter(m => {
                const type = (m.type || "").toLowerCase();
                return type === "image" || type === "img" || type === "picture" || !!m.image;
              })
              .map(m => ({
                id: m.id,
                senderName: m.senderName || m.senderId || "未知",
                timestamp: m.timestamp || m.createdAt || 0,
                dataUrl: m.image || m.img || m.data || m.url || m.text || "",
              }))
              .filter(item => item.dataUrl && item.dataUrl.startsWith("data:image"));
            state.historyImages = images;
            if (images.length === 0) {
              showMessage("未找到图片消息", "info");
            } else {
              showMessage("找到 " + images.length + " 张历史图片", "success");
            }
          } catch (e) {
            showMessage("读取历史消息失败：" + e.message, "error");
          }
        }

        // ---------- UI 渲染 ----------
        function showMessage(text, type = "info") {
          state.message = text;
          state.messageType = type;
          render();
        }

        function render() {
          // 清空容器
          container.innerHTML = "";

          // 根样式
          const root = document.createElement("div");
          root.style.cssText = `
            display: flex;
            flex-direction: column;
            height: 100%;
            padding: 20px;
            background: #1a1a2e;
            color: #eee;
            font-family: system-ui, sans-serif;
            overflow-y: auto;
            box-sizing: border-box;
          `;

          // 标题
          const title = document.createElement("h1");
          title.textContent = "📸 角色图片代发";
          title.style.cssText = "font-size: 22px; margin: 0 0 16px 0; font-weight: 300;";
          root.appendChild(title);

          // 选择角色
          const charSection = document.createElement("div");
          charSection.style.marginBottom = "16px";
          const charLabel = document.createElement("label");
          charLabel.textContent = "① 选择角色";
          charLabel.style.display = "block";
          charLabel.style.marginBottom = "6px";
          charLabel.style.fontWeight = "500";
          charSection.appendChild(charLabel);

          const charSelect = document.createElement("select");
          charSelect.style.cssText = `
            width: 100%; padding: 8px; background: #2a2a3e; color: #eee;
            border: 1px solid #444; border-radius: 8px; font-size: 14px;
          `;
          if (state.characters.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "没有角色，请先创建";
            charSelect.appendChild(opt);
          } else {
            state.characters.forEach(c => {
              const opt = document.createElement("option");
              opt.value = c.id;
              opt.textContent = c.handle || c.name || c.id;
              if (c.id === state.selectedCharId) opt.selected = true;
              charSelect.appendChild(opt);
            });
          }
          charSelect.onchange = () => {
            state.selectedCharId = charSelect.value;
            render();
          };
          charSection.appendChild(charSelect);
          root.appendChild(charSection);

          // 图片获取方式
          const imgSection = document.createElement("div");
          imgSection.style.marginBottom = "16px";
          const imgLabel = document.createElement("div");
          imgLabel.textContent = "② 获取图片";
          imgLabel.style.fontWeight = "500";
          imgLabel.style.marginBottom = "8px";
          imgSection.appendChild(imgLabel);

          // 按钮组：从聊天历史 / 上传文件 / 粘贴URL
          const btnGroup = document.createElement("div");
          btnGroup.style.display = "flex";
          btnGroup.style.gap = "8px";
          btnGroup.style.flexWrap = "wrap";

          const historyBtn = document.createElement("button");
          historyBtn.textContent = "📚 聊天历史";
          historyBtn.className = "btn";
          historyBtn.onclick = () => {
            if (!state.selectedCharId) {
              showMessage("请先选择角色", "error");
              return;
            }
            state.showHistoryPicker = !state.showHistoryPicker;
            if (state.showHistoryPicker) {
              loadHistoryImages();
            }
            render();
          };
          btnGroup.appendChild(historyBtn);

          const fileBtn = document.createElement("button");
          fileBtn.textContent = "🖼️ 上传图片";
          fileBtn.className = "btn";
          const fileInput = document.createElement("input");
          fileInput.type = "file";
          fileInput.accept = "image/*";
          fileInput.style.display = "none";
          fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
              const dataUrl = await fileToDataUrl(file);
              const compressed = await compressImage(dataUrl);
              state.imageDataUrl = compressed;
              state.imageSource = "上传文件：" + file.name;
              state.showHistoryPicker = false;
              showMessage("图片已加载", "success");
            } catch (err) {
              showMessage("上传失败：" + err.message, "error");
            }
          };
          fileBtn.onclick = () => fileInput.click();
          btnGroup.appendChild(fileBtn);
          btnGroup.appendChild(fileInput);

          const urlBtn = document.createElement("button");
          urlBtn.textContent = "🔗 粘贴URL";
          urlBtn.className = "btn";
          const urlInput = document.createElement("input");
          urlInput.type = "url";
          urlInput.placeholder = "https://...";
          urlInput.style.cssText = `
            flex: 1; min-width: 160px; padding: 6px 10px;
            background: #2a2a3e; color: #eee; border: 1px solid #444;
            border-radius: 6px; font-size: 13px;
          `;
          const urlConfirm = document.createElement("button");
          urlConfirm.textContent = "加载";
          urlConfirm.className = "btn";
          const urlWrap = document.createElement("div");
          urlWrap.style.display = "flex";
          urlWrap.style.gap = "6px";
          urlWrap.style.marginTop = "8px";
          urlWrap.style.width = "100%";
          urlWrap.appendChild(urlInput);
          urlWrap.appendChild(urlConfirm);
          urlConfirm.onclick = async () => {
            const u = urlInput.value.trim();
            if (!u) { showMessage("请输入图片URL", "error"); return; }
            try {
              const dataUrl = await fetchUrlAsDataUrl(u);
              const compressed = await compressImage(dataUrl);
              state.imageDataUrl = compressed;
              state.imageSource = "URL：" + u;
              state.showHistoryPicker = false;
              showMessage("图片已加载", "success");
            } catch (err) {
              showMessage("加载失败：" + err.message, "error");
            }
          };
          btnGroup.appendChild(urlWrap);
          imgSection.appendChild(btnGroup);
          root.appendChild(imgSection);

          // 历史图片选择器（展开）
          if (state.showHistoryPicker) {
            const historyBox = document.createElement("div");
            historyBox.style.cssText = `
              margin-top: 10px; padding: 10px; background: #0f0f1a;
              border-radius: 8px; max-height: 200px; overflow-y: auto;
            `;
            if (state.historyImages.length === 0) {
              historyBox.textContent = "暂无图片消息";
            } else {
              const grid = document.createElement("div");
              grid.style.display = "grid";
              grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(80px, 1fr))";
              grid.style.gap = "8px";
              state.historyImages.forEach(item => {
                const card = document.createElement("div");
                card.style.cssText = `
                  cursor: pointer; background: #222; border-radius: 6px;
                  overflow: hidden; border: 1px solid #444;
                  transition: 0.2s;
                `;
                card.onmouseover = () => card.style.borderColor = "#6c5ce7";
                card.onmouseout = () => card.style.borderColor = "#444";
                const img = document.createElement("img");
                img.src = item.dataUrl;
                img.style.width = "100%";
                img.style.height = "80px";
                img.style.objectFit = "cover";
                img.style.display = "block";
                const label = document.createElement("div");
                label.textContent = item.senderName.slice(0, 8);
                label.style.cssText = "font-size: 11px; padding: 4px; text-align: center; color: #aaa;";
                card.appendChild(img);
                card.appendChild(label);
                card.onclick = () => {
                  state.imageDataUrl = item.dataUrl;
                  state.imageSource = "聊天历史：" + item.senderName;
                  state.showHistoryPicker = false;
                  showMessage("已选取历史图片", "success");
                };
                grid.appendChild(card);
              });
              historyBox.appendChild(grid);
            }
            root.appendChild(historyBox);
          }

          // 预览已选图片
          if (state.imageDataUrl) {
            const preview = document.createElement("div");
            preview.style.marginTop = "12px";
            preview.style.textAlign = "center";
            const imgPreview = document.createElement("img");
            imgPreview.src = state.imageDataUrl;
            imgPreview.style.cssText = "max-width: 100%; max-height: 200px; border-radius: 8px; border: 1px solid #444;";
            const info = document.createElement("div");
            info.textContent = "来源：" + state.imageSource;
            info.style.cssText = "font-size: 12px; color: #888; margin-top: 4px;";
            preview.appendChild(imgPreview);
            preview.appendChild(info);
            root.appendChild(preview);
          }

          // 发送按钮
          const sendSection = document.createElement("div");
          sendSection.style.marginTop = "16px";
          const sendBtn = document.createElement("button");
          sendBtn.textContent = state.loading ? "发送中..." : "📤 以角色身份发送此图";
          sendBtn.className = "btn primary";
          sendBtn.style.cssText = `
            width: 100%; padding: 12px; font-size: 16px;
            background: #6c5ce7; border: none; border-radius: 8px;
            color: #fff; cursor: pointer;
          `;
          sendBtn.disabled = state.loading || !state.selectedCharId || !state.imageDataUrl;
          sendBtn.onclick = handleSend;
          sendSection.appendChild(sendBtn);
          root.appendChild(sendSection);

          // 消息显示
          if (state.message) {
            const msgBox = document.createElement("div");
            msgBox.style.cssText = `
              margin-top: 12px; padding: 10px; background: #16161c;
              border-radius: 6px; border-left: 3px solid ${state.messageType === "success" ? "#4caf50" : state.messageType === "error" ? "#f44336" : "#ff9800"};
              color: #ccc; font-size: 13px; white-space: pre-wrap;
            `;
            msgBox.textContent = state.message;
            root.appendChild(msgBox);
          }

          // 关闭按钮
          const closeBtn = document.createElement("button");
          closeBtn.textContent = "✕ 关闭";
          closeBtn.style.cssText = `
            margin-top: 16px; padding: 8px 16px; background: transparent;
            border: 1px solid #555; border-radius: 6px; color: #aaa;
            cursor: pointer; align-self: flex-start;
          `;
          closeBtn.onclick = () => roche.ui.closeApp();
          root.appendChild(closeBtn);

          container.appendChild(root);

          // 注入样式（一次）
          if (!document.getElementById("role-image-sender-style")) {
            const style = document.createElement("style");
            style.id = "role-image-sender-style";
            style.textContent = `
              .btn {
                padding: 6px 12px;
                background: #2a2a3e;
                border: 1px solid #444;
                border-radius: 6px;
                color: #eee;
                cursor: pointer;
                font-size: 13px;
                transition: 0.2s;
              }
              .btn:hover {
                background: #3a3a5e;
                border-color: #666;
              }
              .btn.primary:hover {
                background: #5a4bd1;
              }
              .btn.primary:disabled {
                opacity: 0.5;
                cursor: not-allowed;
              }
            `;
            document.head.appendChild(style);
          }
        }

        // ---------- 发送逻辑 ----------
        async function handleSend() {
          if (!state.selectedCharId) {
            showMessage("请选择角色", "error");
            return;
          }
          if (!state.imageDataUrl) {
            showMessage("请先获取图片", "error");
            return;
          }

          state.loading = true;
          showMessage("正在发送...", "info");
          render();

          try {
            // 获取角色详情和 conversationId
            const char = await roche.character.get(state.selectedCharId);
            if (!char) throw new Error("角色不存在");
            const convId = char.conversationId;
            if (!convId) throw new Error("该角色没有关联会话，无法发送");

            // 压缩图片（如果还没压缩）
            let finalDataUrl = state.imageDataUrl;
            if (!finalDataUrl.startsWith("data:image/jpeg")) {
              finalDataUrl = await compressImage(finalDataUrl);
            }

            // 注入消息
            const result = await injectImageAsCharacter(
              state.selectedCharId,
              char.name || "角色",
              convId,
              finalDataUrl
            );

            state.loading = false;
            showMessage(
              `✅ 发送成功！\n消息ID: ${result.msgId}\n会话ID: ${result.convId}\n\n⚠️ 请刷新 Roche 页面，在聊天中找到该图片，长按即可使用「锁脸」。`,
              "success"
            );
          } catch (err) {
            state.loading = false;
            showMessage("❌ 发送失败：" + err.message, "error");
          }
          render();
        }

        // ---------- 初始化 ----------
        await loadCharacters();
        render();
      },
      async unmount(container) {
        container.replaceChildren();
        // 清理注入的样式（可选）
        const style = document.getElementById("role-image-sender-style");
        if (style) style.remove();
      }
    }
  ]
});