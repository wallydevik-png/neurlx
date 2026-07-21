export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      advanced_risk_settings: {
        Row: {
          kelly_fraction: number
          max_correlation: number
          max_portfolio_heat_pct: number
          max_sector_pct: number
          max_var_pct: number
          target_daily_vol_pct: number
          updated_at: string
          user_id: string
        }
        Insert: {
          kelly_fraction?: number
          max_correlation?: number
          max_portfolio_heat_pct?: number
          max_sector_pct?: number
          max_var_pct?: number
          target_daily_vol_pct?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          kelly_fraction?: number
          max_correlation?: number
          max_portfolio_heat_pct?: number
          max_sector_pct?: number
          max_var_pct?: number
          target_daily_vol_pct?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      api_request_log: {
        Row: {
          connection_id: string | null
          created_at: string
          error: string | null
          id: string
          is_signed: boolean
          latency_ms: number | null
          method: string
          order_id: string | null
          path: string
          request_params: Json
          response_snippet: string | null
          status_code: number | null
          user_id: string
          venue: string
        }
        Insert: {
          connection_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          is_signed?: boolean
          latency_ms?: number | null
          method: string
          order_id?: string | null
          path: string
          request_params?: Json
          response_snippet?: string | null
          status_code?: number | null
          user_id: string
          venue: string
        }
        Update: {
          connection_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          is_signed?: boolean
          latency_ms?: number | null
          method?: string
          order_id?: string | null
          path?: string
          request_params?: Json
          response_snippet?: string | null
          status_code?: number | null
          user_id?: string
          venue?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_request_log_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_request_log_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_records: {
        Row: {
          created_at: string
          decision: string
          entity_ref: string | null
          id: string
          kind: string
          payload: Json | null
          rationale: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          decision: string
          entity_ref?: string | null
          id?: string
          kind: string
          payload?: Json | null
          rationale?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          decision?: string
          entity_ref?: string | null
          id?: string
          kind?: string
          payload?: Json | null
          rationale?: string | null
          user_id?: string
        }
        Relationships: []
      }
      asset_universe: {
        Row: {
          asset_class: string
          base: string
          connector_id: string
          created_at: string
          exchange: string
          id: string
          is_active: boolean
          leverage_max: number
          meta: Json | null
          min_notional: number
          quote: string
          symbol: string
          tick_size: number
        }
        Insert: {
          asset_class: string
          base: string
          connector_id: string
          created_at?: string
          exchange: string
          id?: string
          is_active?: boolean
          leverage_max?: number
          meta?: Json | null
          min_notional?: number
          quote: string
          symbol: string
          tick_size?: number
        }
        Update: {
          asset_class?: string
          base?: string
          connector_id?: string
          created_at?: string
          exchange?: string
          id?: string
          is_active?: boolean
          leverage_max?: number
          meta?: Json | null
          min_notional?: number
          quote?: string
          symbol?: string
          tick_size?: number
        }
        Relationships: []
      }
      assistant_conversations: {
        Row: {
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      assistant_messages: {
        Row: {
          content: string
          context_snapshot: Json | null
          conversation_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          content: string
          context_snapshot?: Json | null
          conversation_id: string
          created_at?: string
          id?: string
          role: string
          user_id: string
        }
        Update: {
          content?: string
          context_snapshot?: Json | null
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistant_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "assistant_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          created_at: string
          entity: string | null
          entity_id: string | null
          id: string
          payload: Json | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          payload?: Json | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          payload?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      audit_reports: {
        Row: {
          created_at: string
          id: string
          metrics: Json
          period: string
          period_end: string
          period_start: string
          summary_md: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          metrics?: Json
          period: string
          period_end: string
          period_start: string
          summary_md: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          metrics?: Json
          period?: string
          period_end?: string
          period_start?: string
          summary_md?: string
          user_id?: string
        }
        Relationships: []
      }
      automation_settings: {
        Row: {
          activation_confirmed_phrase_at: string | null
          allowed_assets: string[]
          autonomous_consecutive_losses: number
          autonomous_cooldown_seconds: number
          autonomous_default_connection_id: string | null
          autonomous_last_run_at: string | null
          autonomous_live_enabled: boolean
          autonomous_max_consecutive_losses: number
          autonomous_max_open_positions: number
          autonomous_min_confidence: number
          kill_switch_active: boolean
          live_consecutive_failures: number
          live_kill_reason: string | null
          live_kill_until: string | null
          live_max_notional_per_order: number
          live_rejected_today: number
          live_trading_enabled: boolean
          max_daily_loss: number
          max_trade_size: number
          max_trades_per_day: number
          min_confidence: number
          mode: string
          risk_level: string
          updated_at: string
          user_id: string
        }
        Insert: {
          activation_confirmed_phrase_at?: string | null
          allowed_assets?: string[]
          autonomous_consecutive_losses?: number
          autonomous_cooldown_seconds?: number
          autonomous_default_connection_id?: string | null
          autonomous_last_run_at?: string | null
          autonomous_live_enabled?: boolean
          autonomous_max_consecutive_losses?: number
          autonomous_max_open_positions?: number
          autonomous_min_confidence?: number
          kill_switch_active?: boolean
          live_consecutive_failures?: number
          live_kill_reason?: string | null
          live_kill_until?: string | null
          live_max_notional_per_order?: number
          live_rejected_today?: number
          live_trading_enabled?: boolean
          max_daily_loss?: number
          max_trade_size?: number
          max_trades_per_day?: number
          min_confidence?: number
          mode?: string
          risk_level?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          activation_confirmed_phrase_at?: string | null
          allowed_assets?: string[]
          autonomous_consecutive_losses?: number
          autonomous_cooldown_seconds?: number
          autonomous_default_connection_id?: string | null
          autonomous_last_run_at?: string | null
          autonomous_live_enabled?: boolean
          autonomous_max_consecutive_losses?: number
          autonomous_max_open_positions?: number
          autonomous_min_confidence?: number
          kill_switch_active?: boolean
          live_consecutive_failures?: number
          live_kill_reason?: string | null
          live_kill_until?: string | null
          live_max_notional_per_order?: number
          live_rejected_today?: number
          live_trading_enabled?: boolean
          max_daily_loss?: number
          max_trade_size?: number
          max_trades_per_day?: number
          min_confidence?: number
          mode?: string
          risk_level?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_settings_autonomous_default_connection_id_fkey"
            columns: ["autonomous_default_connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      autonomous_runs: {
        Row: {
          errors: Json
          finished_at: string | null
          id: string
          live: boolean
          reject_reasons: Json
          signals_executed: number
          signals_rejected: number
          signals_scanned: number
          started_at: string
          trigger: string
          user_id: string
        }
        Insert: {
          errors?: Json
          finished_at?: string | null
          id?: string
          live?: boolean
          reject_reasons?: Json
          signals_executed?: number
          signals_rejected?: number
          signals_scanned?: number
          started_at?: string
          trigger?: string
          user_id: string
        }
        Update: {
          errors?: Json
          finished_at?: string | null
          id?: string
          live?: boolean
          reject_reasons?: Json
          signals_executed?: number
          signals_rejected?: number
          signals_scanned?: number
          started_at?: string
          trigger?: string
          user_id?: string
        }
        Relationships: []
      }
      backtest_runs: {
        Row: {
          created_at: string
          equity_curve: Json
          error: string | null
          from_ts: string
          id: string
          interval: string
          kind: string
          label: string | null
          metrics: Json
          params: Json
          parent_run_id: string | null
          status: string
          strategy_id: string | null
          symbol: string
          to_ts: string
          user_id: string
        }
        Insert: {
          created_at?: string
          equity_curve?: Json
          error?: string | null
          from_ts: string
          id?: string
          interval: string
          kind?: string
          label?: string | null
          metrics?: Json
          params?: Json
          parent_run_id?: string | null
          status?: string
          strategy_id?: string | null
          symbol: string
          to_ts: string
          user_id: string
        }
        Update: {
          created_at?: string
          equity_curve?: Json
          error?: string | null
          from_ts?: string
          id?: string
          interval?: string
          kind?: string
          label?: string | null
          metrics?: Json
          params?: Json
          parent_run_id?: string | null
          status?: string
          strategy_id?: string | null
          symbol?: string
          to_ts?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "backtest_runs_parent_run_id_fkey"
            columns: ["parent_run_id"]
            isOneToOne: false
            referencedRelation: "backtest_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backtest_runs_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      backtest_trades: {
        Row: {
          confidence: number | null
          created_at: string
          entry_price: number
          entry_ts: string
          exit_price: number | null
          exit_reason: string | null
          exit_ts: string | null
          id: string
          indicators: Json | null
          market_regime: string | null
          pnl: number | null
          pnl_pct: number | null
          qty: number
          run_id: string
          side: string
          symbol: string
          user_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          entry_price: number
          entry_ts: string
          exit_price?: number | null
          exit_reason?: string | null
          exit_ts?: string | null
          id?: string
          indicators?: Json | null
          market_regime?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          qty: number
          run_id: string
          side: string
          symbol: string
          user_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          entry_price?: number
          entry_ts?: string
          exit_price?: number | null
          exit_reason?: string | null
          exit_ts?: string | null
          id?: string
          indicators?: Json | null
          market_regime?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          qty?: number
          run_id?: string
          side?: string
          symbol?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "backtest_trades_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "backtest_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      capital_allocations: {
        Row: {
          bucket: string
          created_at: string
          id: string
          notes: string | null
          target_pct: number
          updated_at: string
          user_id: string
        }
        Insert: {
          bucket: string
          created_at?: string
          id?: string
          notes?: string | null
          target_pct: number
          updated_at?: string
          user_id: string
        }
        Update: {
          bucket?: string
          created_at?: string
          id?: string
          notes?: string | null
          target_pct?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      capital_ledger: {
        Row: {
          amount_usd: number
          created_at: string
          entry_type: string
          id: string
          note: string | null
          occurred_at: string
          user_id: string
        }
        Insert: {
          amount_usd: number
          created_at?: string
          entry_type: string
          id?: string
          note?: string | null
          occurred_at?: string
          user_id: string
        }
        Update: {
          amount_usd?: number
          created_at?: string
          entry_type?: string
          id?: string
          note?: string | null
          occurred_at?: string
          user_id?: string
        }
        Relationships: []
      }
      capital_policy: {
        Row: {
          cash_reserve_pct: number
          compounding_mode: string
          created_at: string
          fixed_base_usd: number
          profit_withdraw_pct: number
          scale_down_drawdown_pct: number
          scale_up_threshold_pct: number
          updated_at: string
          user_id: string
        }
        Insert: {
          cash_reserve_pct?: number
          compounding_mode?: string
          created_at?: string
          fixed_base_usd?: number
          profit_withdraw_pct?: number
          scale_down_drawdown_pct?: number
          scale_up_threshold_pct?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          cash_reserve_pct?: number
          compounding_mode?: string
          created_at?: string
          fixed_base_usd?: number
          profit_withdraw_pct?: number
          scale_down_drawdown_pct?: number
          scale_up_threshold_pct?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      capital_scale_recommendations: {
        Row: {
          created_at: string
          current_allocation: number | null
          decided_at: string | null
          direction: string
          id: string
          reasons: Json
          status: string
          suggested_allocation: number | null
          user_id: string
        }
        Insert: {
          created_at?: string
          current_allocation?: number | null
          decided_at?: string | null
          direction: string
          id?: string
          reasons?: Json
          status?: string
          suggested_allocation?: number | null
          user_id: string
        }
        Update: {
          created_at?: string
          current_allocation?: number | null
          decided_at?: string | null
          direction?: string
          id?: string
          reasons?: Json
          status?: string
          suggested_allocation?: number | null
          user_id?: string
        }
        Relationships: []
      }
      capital_snapshots: {
        Row: {
          cash_balance: number
          created_at: string
          equity: number
          gross_exposure: number
          id: string
          open_positions: number
          realized_pnl_total: number
          snapshot_date: string
          unrealized_pnl: number
          user_id: string
        }
        Insert: {
          cash_balance?: number
          created_at?: string
          equity?: number
          gross_exposure?: number
          id?: string
          open_positions?: number
          realized_pnl_total?: number
          snapshot_date: string
          unrealized_pnl?: number
          user_id: string
        }
        Update: {
          cash_balance?: number
          created_at?: string
          equity?: number
          gross_exposure?: number
          id?: string
          open_positions?: number
          realized_pnl_total?: number
          snapshot_date?: string
          unrealized_pnl?: number
          user_id?: string
        }
        Relationships: []
      }
      configuration_snapshots: {
        Row: {
          automation: Json | null
          capital_policy: Json | null
          created_at: string
          id: string
          label: string
          risk: Json | null
          user_id: string
        }
        Insert: {
          automation?: Json | null
          capital_policy?: Json | null
          created_at?: string
          id?: string
          label: string
          risk?: Json | null
          user_id: string
        }
        Update: {
          automation?: Json | null
          capital_policy?: Json | null
          created_at?: string
          id?: string
          label?: string
          risk?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      copy_subscriptions: {
        Row: {
          active: boolean
          allocation_pct: number
          created_at: string
          follower_id: string
          id: string
          leader_id: string
          max_position_size: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          allocation_pct?: number
          created_at?: string
          follower_id: string
          id?: string
          leader_id: string
          max_position_size?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          allocation_pct?: number
          created_at?: string
          follower_id?: string
          id?: string
          leader_id?: string
          max_position_size?: number
          updated_at?: string
        }
        Relationships: []
      }
      deployment_history: {
        Row: {
          actor: string
          after_state: Json | null
          before_state: Json | null
          change_type: string
          created_at: string
          id: string
          reason: string | null
          summary: string
          user_id: string
        }
        Insert: {
          actor?: string
          after_state?: Json | null
          before_state?: Json | null
          change_type: string
          created_at?: string
          id?: string
          reason?: string | null
          summary: string
          user_id: string
        }
        Update: {
          actor?: string
          after_state?: Json | null
          before_state?: Json | null
          change_type?: string
          created_at?: string
          id?: string
          reason?: string | null
          summary?: string
          user_id?: string
        }
        Relationships: []
      }
      emergency_check_runs: {
        Row: {
          created_at: string
          failed: number
          id: string
          passed: number
          results: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          failed?: number
          id?: string
          passed?: number
          results: Json
          user_id: string
        }
        Update: {
          created_at?: string
          failed?: number
          id?: string
          passed?: number
          results?: Json
          user_id?: string
        }
        Relationships: []
      }
      exchange_connections: {
        Row: {
          account_number: string | null
          auth_method: string | null
          broker_category: string | null
          broker_server: string | null
          clock_skew_ms: number | null
          connector_id: string
          created_at: string
          credential_ciphertext: string | null
          error_history: Json
          health: string
          id: string
          label: string
          last_error: string | null
          last_reconcile_at: string | null
          last_sync_at: string | null
          last_test_at: string | null
          last_test_report: Json | null
          latency_ms: number | null
          max_notional_per_order: number | null
          oauth_expires_at: string | null
          oauth_token_ciphertext: string | null
          permission_scan: Json | null
          permissions_snapshot: Json
          read_enabled: boolean
          status: string
          trading_activated_at: string | null
          trading_enabled: boolean
          unnecessary_permissions: string[]
          updated_at: string
          user_id: string
          withdrawal_detected: boolean
        }
        Insert: {
          account_number?: string | null
          auth_method?: string | null
          broker_category?: string | null
          broker_server?: string | null
          clock_skew_ms?: number | null
          connector_id: string
          created_at?: string
          credential_ciphertext?: string | null
          error_history?: Json
          health?: string
          id?: string
          label: string
          last_error?: string | null
          last_reconcile_at?: string | null
          last_sync_at?: string | null
          last_test_at?: string | null
          last_test_report?: Json | null
          latency_ms?: number | null
          max_notional_per_order?: number | null
          oauth_expires_at?: string | null
          oauth_token_ciphertext?: string | null
          permission_scan?: Json | null
          permissions_snapshot?: Json
          read_enabled?: boolean
          status?: string
          trading_activated_at?: string | null
          trading_enabled?: boolean
          unnecessary_permissions?: string[]
          updated_at?: string
          user_id: string
          withdrawal_detected?: boolean
        }
        Update: {
          account_number?: string | null
          auth_method?: string | null
          broker_category?: string | null
          broker_server?: string | null
          clock_skew_ms?: number | null
          connector_id?: string
          created_at?: string
          credential_ciphertext?: string | null
          error_history?: Json
          health?: string
          id?: string
          label?: string
          last_error?: string | null
          last_reconcile_at?: string | null
          last_sync_at?: string | null
          last_test_at?: string | null
          last_test_report?: Json | null
          latency_ms?: number | null
          max_notional_per_order?: number | null
          oauth_expires_at?: string | null
          oauth_token_ciphertext?: string | null
          permission_scan?: Json | null
          permissions_snapshot?: Json
          read_enabled?: boolean
          status?: string
          trading_activated_at?: string | null
          trading_enabled?: boolean
          unnecessary_permissions?: string[]
          updated_at?: string
          user_id?: string
          withdrawal_detected?: boolean
        }
        Relationships: []
      }
      execution_log: {
        Row: {
          created_at: string
          event: string
          id: string
          message: string | null
          order_id: string | null
          payload: Json
          position_id: string | null
          severity: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          message?: string | null
          order_id?: string | null
          payload?: Json
          position_id?: string | null
          severity?: string
          user_id: string
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          message?: string | null
          order_id?: string | null
          payload?: Json
          position_id?: string | null
          severity?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "execution_log_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "execution_log_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      follows: {
        Row: {
          created_at: string
          follower_id: string
          following_id: string
        }
        Insert: {
          created_at?: string
          follower_id: string
          following_id: string
        }
        Update: {
          created_at?: string
          follower_id?: string
          following_id?: string
        }
        Relationships: []
      }
      gdpr_requests: {
        Row: {
          completed_at: string | null
          id: string
          kind: string
          notes: string | null
          requested_at: string
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          id?: string
          kind: string
          notes?: string | null
          requested_at?: string
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          id?: string
          kind?: string
          notes?: string | null
          requested_at?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      market_candles: {
        Row: {
          close: number
          created_at: string
          high: number
          id: number
          interval: string
          low: number
          open: number
          source: string
          symbol: string
          ts: string
          volume: number
        }
        Insert: {
          close: number
          created_at?: string
          high: number
          id?: number
          interval: string
          low: number
          open: number
          source?: string
          symbol: string
          ts: string
          volume?: number
        }
        Update: {
          close?: number
          created_at?: string
          high?: number
          id?: number
          interval?: string
          low?: number
          open?: number
          source?: string
          symbol?: string
          ts?: string
          volume?: number
        }
        Relationships: []
      }
      market_intel: {
        Row: {
          confidence: number
          expires_at: string
          id: string
          kind: string
          payload: Json
          provider: string
          score: number
          symbol: string
          ts: string
        }
        Insert: {
          confidence?: number
          expires_at?: string
          id?: string
          kind: string
          payload?: Json
          provider: string
          score: number
          symbol: string
          ts?: string
        }
        Update: {
          confidence?: number
          expires_at?: string
          id?: string
          kind?: string
          payload?: Json
          provider?: string
          score?: number
          symbol?: string
          ts?: string
        }
        Relationships: []
      }
      model_drift_snapshots: {
        Row: {
          accuracy: number | null
          accuracy_delta: number | null
          brier: number | null
          calibration_error: number | null
          created_at: string
          details: Json | null
          distribution_shift: number | null
          drift_flag: boolean
          drift_reason: string | null
          id: string
          model: string
          sample_size: number
          user_id: string
          window_days: number
        }
        Insert: {
          accuracy?: number | null
          accuracy_delta?: number | null
          brier?: number | null
          calibration_error?: number | null
          created_at?: string
          details?: Json | null
          distribution_shift?: number | null
          drift_flag?: boolean
          drift_reason?: string | null
          id?: string
          model: string
          sample_size: number
          user_id: string
          window_days: number
        }
        Update: {
          accuracy?: number | null
          accuracy_delta?: number | null
          brier?: number | null
          calibration_error?: number | null
          created_at?: string
          details?: Json | null
          distribution_shift?: number | null
          drift_flag?: boolean
          drift_reason?: string | null
          id?: string
          model?: string
          sample_size?: number
          user_id?: string
          window_days?: number
        }
        Relationships: []
      }
      notification_preferences: {
        Row: {
          channels: Json
          created_at: string
          discord_webhook_url: string | null
          email_address: string | null
          kind_toggles: Json
          quiet_hours_end: number | null
          quiet_hours_start: number | null
          severity_min: string
          telegram_chat_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          channels?: Json
          created_at?: string
          discord_webhook_url?: string | null
          email_address?: string | null
          kind_toggles?: Json
          quiet_hours_end?: number | null
          quiet_hours_start?: number | null
          severity_min?: string
          telegram_chat_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          channels?: Json
          created_at?: string
          discord_webhook_url?: string | null
          email_address?: string | null
          kind_toggles?: Json
          quiet_hours_end?: number | null
          quiet_hours_start?: number | null
          severity_min?: string
          telegram_chat_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          channels_delivered: string[]
          created_at: string
          id: string
          kind: string
          message: string
          payload: Json
          read_at: string | null
          severity: string
          title: string
          user_id: string
        }
        Insert: {
          channels_delivered?: string[]
          created_at?: string
          id?: string
          kind: string
          message: string
          payload?: Json
          read_at?: string | null
          severity?: string
          title: string
          user_id: string
        }
        Update: {
          channels_delivered?: string[]
          created_at?: string
          id?: string
          kind?: string
          message?: string
          payload?: Json
          read_at?: string | null
          severity?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      optimization_recommendations: {
        Row: {
          applied_at: string | null
          approved_at: string | null
          created_at: string
          evidence: Json | null
          id: string
          kind: string
          rationale: string
          rejected_at: string | null
          reviewer_note: string | null
          severity: string
          status: string
          suggested_change: Json
          target: string | null
          title: string
          user_id: string
        }
        Insert: {
          applied_at?: string | null
          approved_at?: string | null
          created_at?: string
          evidence?: Json | null
          id?: string
          kind: string
          rationale: string
          rejected_at?: string | null
          reviewer_note?: string | null
          severity?: string
          status?: string
          suggested_change: Json
          target?: string | null
          title: string
          user_id: string
        }
        Update: {
          applied_at?: string | null
          approved_at?: string | null
          created_at?: string
          evidence?: Json | null
          id?: string
          kind?: string
          rationale?: string
          rejected_at?: string | null
          reviewer_note?: string | null
          severity?: string
          status?: string
          suggested_change?: Json
          target?: string | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      optimization_runs: {
        Row: {
          bars: number
          best_metrics: Json
          best_params: Json
          created_at: string
          id: string
          interval: string
          param_grid: Json
          results: Json
          strategy_id: string | null
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          bars: number
          best_metrics: Json
          best_params: Json
          created_at?: string
          id?: string
          interval: string
          param_grid: Json
          results: Json
          strategy_id?: string | null
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          bars?: number
          best_metrics?: Json
          best_params?: Json
          created_at?: string
          id?: string
          interval?: string
          param_grid?: Json
          results?: Json
          strategy_id?: string | null
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "optimization_runs_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          account_id: string
          client_order_id: string | null
          created_at: string
          error_message: string | null
          execution_venue: string
          external_order_id: string | null
          fees: number | null
          filled_at: string | null
          filled_price: number | null
          id: string
          is_live: boolean
          limit_price: number | null
          order_type: string
          parent_order_id: string | null
          position_id: string | null
          qty: number
          retry_count: number
          side: string
          slippage_bps: number | null
          status: string
          stop_price: number | null
          submitted_at: string | null
          symbol: string
          trailing_stop_pct: number | null
          user_id: string
        }
        Insert: {
          account_id: string
          client_order_id?: string | null
          created_at?: string
          error_message?: string | null
          execution_venue?: string
          external_order_id?: string | null
          fees?: number | null
          filled_at?: string | null
          filled_price?: number | null
          id?: string
          is_live?: boolean
          limit_price?: number | null
          order_type?: string
          parent_order_id?: string | null
          position_id?: string | null
          qty: number
          retry_count?: number
          side: string
          slippage_bps?: number | null
          status?: string
          stop_price?: number | null
          submitted_at?: string | null
          symbol: string
          trailing_stop_pct?: number | null
          user_id: string
        }
        Update: {
          account_id?: string
          client_order_id?: string | null
          created_at?: string
          error_message?: string | null
          execution_venue?: string
          external_order_id?: string | null
          fees?: number | null
          filled_at?: string | null
          filled_price?: number | null
          id?: string
          is_live?: boolean
          limit_price?: number | null
          order_type?: string
          parent_order_id?: string | null
          position_id?: string | null
          qty?: number
          retry_count?: number
          side?: string
          slippage_bps?: number | null
          status?: string
          stop_price?: number | null
          submitted_at?: string | null
          symbol?: string
          trailing_stop_pct?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "paper_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_parent_order_id_fkey"
            columns: ["parent_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
        ]
      }
      paper_accounts: {
        Row: {
          base_currency: string
          cash_balance: number
          connection_id: string | null
          created_at: string
          equity: number
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          base_currency?: string
          cash_balance?: number
          connection_id?: string | null
          created_at?: string
          equity?: number
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          base_currency?: string
          cash_balance?: number
          connection_id?: string | null
          created_at?: string
          equity?: number
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_accounts_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "exchange_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          account_id: string
          ai_confidence: number | null
          ai_reasoning: string | null
          ai_regime: string | null
          avg_entry: number
          break_even_moved: boolean
          closed_at: string | null
          duration_seconds: number | null
          exit_price: number | null
          exit_reason: string | null
          filled_qty: number | null
          id: string
          opened_at: string
          original_qty: number | null
          partial_take_profit_pct: number | null
          qty: number
          realized_pnl: number | null
          side: string
          status: string
          stop_loss: number | null
          strategy_id: string | null
          symbol: string
          take_profit: number | null
          trailing_activated_at: string | null
          trailing_high_water: number | null
          trailing_stop_pct: number | null
          user_id: string
        }
        Insert: {
          account_id: string
          ai_confidence?: number | null
          ai_reasoning?: string | null
          ai_regime?: string | null
          avg_entry: number
          break_even_moved?: boolean
          closed_at?: string | null
          duration_seconds?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          filled_qty?: number | null
          id?: string
          opened_at?: string
          original_qty?: number | null
          partial_take_profit_pct?: number | null
          qty: number
          realized_pnl?: number | null
          side: string
          status?: string
          stop_loss?: number | null
          strategy_id?: string | null
          symbol: string
          take_profit?: number | null
          trailing_activated_at?: string | null
          trailing_high_water?: number | null
          trailing_stop_pct?: number | null
          user_id: string
        }
        Update: {
          account_id?: string
          ai_confidence?: number | null
          ai_reasoning?: string | null
          ai_regime?: string | null
          avg_entry?: number
          break_even_moved?: boolean
          closed_at?: string | null
          duration_seconds?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          filled_qty?: number | null
          id?: string
          opened_at?: string
          original_qty?: number | null
          partial_take_profit_pct?: number | null
          qty?: number
          realized_pnl?: number | null
          side?: string
          status?: string
          stop_loss?: number | null
          strategy_id?: string | null
          symbol?: string
          take_profit?: number | null
          trailing_activated_at?: string | null
          trailing_high_water?: number | null
          trailing_stop_pct?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "paper_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      production_checklist_items: {
        Row: {
          id: string
          key: string
          note: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          key: string
          note?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          key?: string
          note?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profile_stats: {
        Row: {
          followers_count: number
          max_drawdown_pct: number
          sharpe: number
          total_return_pct: number
          trades_count: number
          updated_at: string
          user_id: string
          win_rate: number
        }
        Insert: {
          followers_count?: number
          max_drawdown_pct?: number
          sharpe?: number
          total_return_pct?: number
          trades_count?: number
          updated_at?: string
          user_id: string
          win_rate?: number
        }
        Update: {
          followers_count?: number
          max_drawdown_pct?: number
          sharpe?: number
          total_return_pct?: number
          trades_count?: number
          updated_at?: string
          user_id?: string
          win_rate?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          autonomous_disclaimer_acked_at: string | null
          created_at: string
          deletion_requested_at: string | null
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          autonomous_disclaimer_acked_at?: string | null
          created_at?: string
          deletion_requested_at?: string | null
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          autonomous_disclaimer_acked_at?: string | null
          created_at?: string
          deletion_requested_at?: string | null
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      public_profiles: {
        Row: {
          allow_copy: boolean
          avatar_url: string | null
          bio: string | null
          created_at: string
          display_name: string
          is_public: boolean
          updated_at: string
          user_id: string
          verified: boolean
        }
        Insert: {
          allow_copy?: boolean
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          display_name: string
          is_public?: boolean
          updated_at?: string
          user_id: string
          verified?: boolean
        }
        Update: {
          allow_copy?: boolean
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          display_name?: string
          is_public?: boolean
          updated_at?: string
          user_id?: string
          verified?: boolean
        }
        Relationships: []
      }
      readiness_snapshots: {
        Row: {
          blockers: Json
          capital_tier: string
          category_scores: Json
          created_at: string
          id: string
          metrics: Json
          overall_score: number
          tier: string
          user_id: string
        }
        Insert: {
          blockers?: Json
          capital_tier: string
          category_scores?: Json
          created_at?: string
          id?: string
          metrics?: Json
          overall_score: number
          tier: string
          user_id: string
        }
        Update: {
          blockers?: Json
          capital_tier?: string
          category_scores?: Json
          created_at?: string
          id?: string
          metrics?: Json
          overall_score?: number
          tier?: string
          user_id?: string
        }
        Relationships: []
      }
      recommendation_audit: {
        Row: {
          action: string
          after_state: Json | null
          before_state: Json | null
          created_at: string
          id: string
          note: string | null
          recommendation_id: string
          user_id: string
        }
        Insert: {
          action: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: string
          note?: string | null
          recommendation_id: string
          user_id: string
        }
        Update: {
          action?: string
          after_state?: Json | null
          before_state?: Json | null
          created_at?: string
          id?: string
          note?: string | null
          recommendation_id?: string
          user_id?: string
        }
        Relationships: []
      }
      recovery_events: {
        Row: {
          created_at: string
          detail: Json
          event_type: string
          id: string
          message: string
          severity: string
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          event_type: string
          id?: string
          message: string
          severity?: string
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: Json
          event_type?: string
          id?: string
          message?: string
          severity?: string
          user_id?: string
        }
        Relationships: []
      }
      research_hypotheses: {
        Row: {
          created_at: string
          description: string | null
          dsl: Json
          id: string
          interval: string
          last_metrics: Json | null
          last_run_at: string | null
          name: string
          status: string
          symbol: string
          tags: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          dsl: Json
          id?: string
          interval?: string
          last_metrics?: Json | null
          last_run_at?: string | null
          name: string
          status?: string
          symbol: string
          tags?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          dsl?: Json
          id?: string
          interval?: string
          last_metrics?: Json | null
          last_run_at?: string | null
          name?: string
          status?: string
          symbol?: string
          tags?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      risk_acknowledgments: {
        Row: {
          acknowledged_at: string
          id: string
          kind: string
          text_hash: string | null
          user_id: string
          version: string
        }
        Insert: {
          acknowledged_at?: string
          id?: string
          kind: string
          text_hash?: string | null
          user_id: string
          version: string
        }
        Update: {
          acknowledged_at?: string
          id?: string
          kind?: string
          text_hash?: string | null
          user_id?: string
          version?: string
        }
        Relationships: []
      }
      risk_snapshots: {
        Row: {
          captured_at: string
          cvar_95_pct: number
          equity: number
          id: string
          max_correlation: number
          open_positions: number
          portfolio_heat_pct: number
          portfolio_vol_pct: number
          risk_score: number
          user_id: string
          var_95_pct: number
        }
        Insert: {
          captured_at?: string
          cvar_95_pct?: number
          equity: number
          id?: string
          max_correlation?: number
          open_positions?: number
          portfolio_heat_pct?: number
          portfolio_vol_pct?: number
          risk_score?: number
          user_id: string
          var_95_pct?: number
        }
        Update: {
          captured_at?: string
          cvar_95_pct?: number
          equity?: number
          id?: string
          max_correlation?: number
          open_positions?: number
          portfolio_heat_pct?: number
          portfolio_vol_pct?: number
          risk_score?: number
          user_id?: string
          var_95_pct?: number
        }
        Relationships: []
      }
      shadow_trades: {
        Row: {
          close_price: number | null
          close_ts: string | null
          confidence: number
          created_at: string
          entry_price: number
          entry_ts: string
          exit_reason: string | null
          id: string
          indicators: Json
          market_regime: string | null
          pnl: number | null
          pnl_pct: number | null
          qty: number
          side: string
          status: string
          stop_loss: number
          strategy_id: string | null
          symbol: string
          take_profit: number
          updated_at: string
          user_id: string
        }
        Insert: {
          close_price?: number | null
          close_ts?: string | null
          confidence: number
          created_at?: string
          entry_price: number
          entry_ts?: string
          exit_reason?: string | null
          id?: string
          indicators?: Json
          market_regime?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          qty: number
          side: string
          status?: string
          stop_loss: number
          strategy_id?: string | null
          symbol: string
          take_profit: number
          updated_at?: string
          user_id: string
        }
        Update: {
          close_price?: number | null
          close_ts?: string | null
          confidence?: number
          created_at?: string
          entry_price?: number
          entry_ts?: string
          exit_reason?: string | null
          id?: string
          indicators?: Json
          market_regime?: string | null
          pnl?: number | null
          pnl_pct?: number | null
          qty?: number
          side?: string
          status?: string
          stop_loss?: number
          strategy_id?: string | null
          symbol?: string
          take_profit?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shadow_trades_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      signals: {
        Row: {
          confidence: number
          contributions: Json
          created_at: string
          entry: number
          evaluated_at: string | null
          expires_at: string | null
          id: string
          indicators: Json
          market_regime: string | null
          outcome_pnl_pct: number | null
          outcome_status: string | null
          qty: number
          reasoning: string
          resolved_at: string | null
          risk_factors: Json
          risk_level: string
          risk_reward: number | null
          side: string
          status: string
          stop_loss: number
          symbol: string
          take_profit: number
          time_horizon: string
          user_id: string
        }
        Insert: {
          confidence: number
          contributions?: Json
          created_at?: string
          entry: number
          evaluated_at?: string | null
          expires_at?: string | null
          id?: string
          indicators?: Json
          market_regime?: string | null
          outcome_pnl_pct?: number | null
          outcome_status?: string | null
          qty: number
          reasoning: string
          resolved_at?: string | null
          risk_factors?: Json
          risk_level?: string
          risk_reward?: number | null
          side: string
          status?: string
          stop_loss: number
          symbol: string
          take_profit: number
          time_horizon?: string
          user_id: string
        }
        Update: {
          confidence?: number
          contributions?: Json
          created_at?: string
          entry?: number
          evaluated_at?: string | null
          expires_at?: string | null
          id?: string
          indicators?: Json
          market_regime?: string | null
          outcome_pnl_pct?: number | null
          outcome_status?: string | null
          qty?: number
          reasoning?: string
          resolved_at?: string | null
          risk_factors?: Json
          risk_level?: string
          risk_reward?: number | null
          side?: string
          status?: string
          stop_loss?: number
          symbol?: string
          take_profit?: number
          time_horizon?: string
          user_id?: string
        }
        Relationships: []
      }
      state_snapshots: {
        Row: {
          captured_at: string
          id: string
          kind: string
          payload: Json
          user_id: string
        }
        Insert: {
          captured_at?: string
          id?: string
          kind: string
          payload: Json
          user_id: string
        }
        Update: {
          captured_at?: string
          id?: string
          kind?: string
          payload?: Json
          user_id?: string
        }
        Relationships: []
      }
      strategies: {
        Row: {
          capital_allocation_pct: number
          created_at: string
          health_notes: string | null
          health_status: string
          id: string
          interval: string
          is_active: boolean
          last_evaluated_at: string | null
          name: string
          notes: string | null
          params: Json
          strategy_type: string
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          capital_allocation_pct?: number
          created_at?: string
          health_notes?: string | null
          health_status?: string
          id?: string
          interval?: string
          is_active?: boolean
          last_evaluated_at?: string | null
          name: string
          notes?: string | null
          params?: Json
          strategy_type?: string
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          capital_allocation_pct?: number
          created_at?: string
          health_notes?: string | null
          health_status?: string
          id?: string
          interval?: string
          is_active?: boolean
          last_evaluated_at?: string | null
          name?: string
          notes?: string | null
          params?: Json
          strategy_type?: string
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      strategy_health_scores: {
        Row: {
          classification: string
          created_at: string
          details: Json | null
          drawdown: number | null
          execution_quality: number | null
          id: string
          profitability: number | null
          recent_perf: number | null
          regime_fit: number | null
          sample_size: number | null
          score: number
          sharpe: number | null
          stability: number | null
          strategy_id: string
          user_id: string
        }
        Insert: {
          classification: string
          created_at?: string
          details?: Json | null
          drawdown?: number | null
          execution_quality?: number | null
          id?: string
          profitability?: number | null
          recent_perf?: number | null
          regime_fit?: number | null
          sample_size?: number | null
          score: number
          sharpe?: number | null
          stability?: number | null
          strategy_id: string
          user_id: string
        }
        Update: {
          classification?: string
          created_at?: string
          details?: Json | null
          drawdown?: number | null
          execution_quality?: number | null
          id?: string
          profitability?: number | null
          recent_perf?: number | null
          regime_fit?: number | null
          sample_size?: number | null
          score?: number
          sharpe?: number | null
          stability?: number | null
          strategy_id?: string
          user_id?: string
        }
        Relationships: []
      }
      system_heartbeats: {
        Row: {
          component: string
          detail: Json
          id: string
          latency_ms: number | null
          observed_at: string
          status: string
          user_id: string
        }
        Insert: {
          component: string
          detail?: Json
          id?: string
          latency_ms?: number | null
          observed_at?: string
          status?: string
          user_id: string
        }
        Update: {
          component?: string
          detail?: Json
          id?: string
          latency_ms?: number | null
          observed_at?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      system_status: {
        Row: {
          degraded_since: string | null
          last_watchdog_at: string | null
          mode: string
          reason: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          degraded_since?: string | null
          last_watchdog_at?: string | null
          mode?: string
          reason?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          degraded_since?: string | null
          last_watchdog_at?: string | null
          mode?: string
          reason?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trade_journal: {
        Row: {
          actual_outcome: string | null
          ai_confidence: number | null
          attribution: Json
          created_at: string
          duration_seconds: number | null
          entry_price: number | null
          entry_reason: string | null
          execution_latency_ms: number | null
          execution_quality_score: number | null
          exit_price: number | null
          exit_reason: string | null
          fees_total: number | null
          id: string
          indicators: Json | null
          lessons: string | null
          market_regime: string | null
          model_version: string | null
          position_id: string | null
          predicted_outcome: string | null
          qty: number | null
          realized_pnl: number | null
          side: string
          signal_id: string | null
          slippage_bps_avg: number | null
          strategy_id: string | null
          symbol: string
          user_id: string
          user_modifications: number
        }
        Insert: {
          actual_outcome?: string | null
          ai_confidence?: number | null
          attribution?: Json
          created_at?: string
          duration_seconds?: number | null
          entry_price?: number | null
          entry_reason?: string | null
          execution_latency_ms?: number | null
          execution_quality_score?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          fees_total?: number | null
          id?: string
          indicators?: Json | null
          lessons?: string | null
          market_regime?: string | null
          model_version?: string | null
          position_id?: string | null
          predicted_outcome?: string | null
          qty?: number | null
          realized_pnl?: number | null
          side: string
          signal_id?: string | null
          slippage_bps_avg?: number | null
          strategy_id?: string | null
          symbol: string
          user_id: string
          user_modifications?: number
        }
        Update: {
          actual_outcome?: string | null
          ai_confidence?: number | null
          attribution?: Json
          created_at?: string
          duration_seconds?: number | null
          entry_price?: number | null
          entry_reason?: string | null
          execution_latency_ms?: number | null
          execution_quality_score?: number | null
          exit_price?: number | null
          exit_reason?: string | null
          fees_total?: number | null
          id?: string
          indicators?: Json | null
          lessons?: string | null
          market_regime?: string | null
          model_version?: string | null
          position_id?: string | null
          predicted_outcome?: string | null
          qty?: number | null
          realized_pnl?: number | null
          side?: string
          signal_id?: string | null
          slippage_bps_avg?: number | null
          strategy_id?: string | null
          symbol?: string
          user_id?: string
          user_modifications?: number
        }
        Relationships: [
          {
            foreignKeyName: "trade_journal_position_id_fkey"
            columns: ["position_id"]
            isOneToOne: false
            referencedRelation: "positions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_journal_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_reviews: {
        Row: {
          ai_model: string | null
          confidence: number | null
          confidence_accuracy: string | null
          created_at: string
          failure_factors: string | null
          id: string
          journal_id: string | null
          lessons: string | null
          market_condition_change: string | null
          outcome: string | null
          realized_pnl: number | null
          regime: string | null
          risk_appropriateness: string | null
          strategy_id: string | null
          success_factors: string | null
          symbol: string | null
          user_id: string
        }
        Insert: {
          ai_model?: string | null
          confidence?: number | null
          confidence_accuracy?: string | null
          created_at?: string
          failure_factors?: string | null
          id?: string
          journal_id?: string | null
          lessons?: string | null
          market_condition_change?: string | null
          outcome?: string | null
          realized_pnl?: number | null
          regime?: string | null
          risk_appropriateness?: string | null
          strategy_id?: string | null
          success_factors?: string | null
          symbol?: string | null
          user_id: string
        }
        Update: {
          ai_model?: string | null
          confidence?: number | null
          confidence_accuracy?: string | null
          created_at?: string
          failure_factors?: string | null
          id?: string
          journal_id?: string | null
          lessons?: string | null
          market_condition_change?: string | null
          outcome?: string | null
          realized_pnl?: number | null
          regime?: string | null
          risk_appropriateness?: string | null
          strategy_id?: string | null
          success_factors?: string | null
          symbol?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_consents: {
        Row: {
          marketing_opt_in: boolean
          privacy_accepted_at: string | null
          privacy_version: string | null
          risk_accepted_at: string | null
          risk_version: string | null
          tos_accepted_at: string | null
          tos_version: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          marketing_opt_in?: boolean
          privacy_accepted_at?: string | null
          privacy_version?: string | null
          risk_accepted_at?: string | null
          risk_version?: string | null
          tos_accepted_at?: string | null
          tos_version?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          marketing_opt_in?: boolean
          privacy_accepted_at?: string | null
          privacy_version?: string | null
          risk_accepted_at?: string | null
          risk_version?: string | null
          tos_accepted_at?: string | null
          tos_version?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_watchlists: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          instrument_id: string
          notes: string | null
          priority: number
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          instrument_id: string
          notes?: string | null
          priority?: number
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          instrument_id?: string
          notes?: string | null
          priority?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_watchlists_instrument_id_fkey"
            columns: ["instrument_id"]
            isOneToOne: false
            referencedRelation: "asset_universe"
            referencedColumns: ["id"]
          },
        ]
      }
      webauthn_challenges: {
        Row: {
          challenge: string
          created_at: string
          expires_at: string
          id: string
          purpose: string
          user_id: string
        }
        Insert: {
          challenge: string
          created_at?: string
          expires_at?: string
          id?: string
          purpose?: string
          user_id: string
        }
        Update: {
          challenge?: string
          created_at?: string
          expires_at?: string
          id?: string
          purpose?: string
          user_id?: string
        }
        Relationships: []
      }
      webauthn_credentials: {
        Row: {
          backed_up: boolean
          counter: number
          created_at: string
          credential_id: string
          device_type: string
          id: string
          is_active: boolean
          last_used_at: string | null
          nickname: string | null
          public_key: string
          transports: string[]
          user_id: string
        }
        Insert: {
          backed_up?: boolean
          counter?: number
          created_at?: string
          credential_id: string
          device_type?: string
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          nickname?: string | null
          public_key: string
          transports?: string[]
          user_id: string
        }
        Update: {
          backed_up?: boolean
          counter?: number
          created_at?: string
          credential_id?: string
          device_type?: string
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          nickname?: string | null
          public_key?: string
          transports?: string[]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
